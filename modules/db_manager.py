import sqlite3
import json
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Any, List, Optional, Iterator
from modules.config import DB_PATH


LEVEL_TITLES = [
    (1, "🌱 입문 탐구자"),
    (2, "📖 성실한 독서가"),
    (3, "✏️ 노트 정리 장인"),
    (5, "🔥 열정의 학자"),
    (8, "🧠 지식 아키텍트"),
    (12, "🎓 마스터 연구원"),
    (18, "👑 그랜드 마스터 디렉터"),
]


class DatabaseManager:
    """
    Cross-device persistent storage for reading progress, bookmarks, highlights,
    flashcards, per-document study scratchpad notes, study streaks/XP, e-book settings,
    and persistent Vault Document Index Cache (vault_doc_cache).
    Stored completely outside the Obsidian vault so the vault remains 100% Read-Only.
    Uses persistent per-path SQLite connections to eliminate NAS Btrfs WAL/SHM open overhead.
    """

    _pool_guard = threading.Lock()
    _connections: Dict[str, sqlite3.Connection] = {}
    _locks: Dict[str, threading.RLock] = {}
    _initialized_dbs: set = set()
    _settings_cache: Dict[str, Dict[str, Any]] = {}

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = Path(db_path).resolve()
        db_key = str(self.db_path)
        if db_key not in DatabaseManager._initialized_dbs or not self.db_path.exists():
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            if not self.db_path.exists() and db_key in DatabaseManager._connections:
                try:
                    DatabaseManager._connections.pop(db_key).close()
                except Exception:
                    pass
            self._init_db()
            DatabaseManager._initialized_dbs.add(db_key)

    @contextmanager
    def _get_conn(self) -> Iterator[sqlite3.Connection]:
        db_key = str(self.db_path)
        with DatabaseManager._pool_guard:
            lock = DatabaseManager._locks.get(db_key)
            if lock is None:
                lock = threading.RLock()
                DatabaseManager._locks[db_key] = lock

            conn = DatabaseManager._connections.get(db_key)
            if conn is None:
                conn = sqlite3.connect(db_key, timeout=15.0, check_same_thread=False)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode=MEMORY;")
                conn.execute("PRAGMA synchronous=OFF;")
                conn.execute("PRAGMA temp_store=MEMORY;")
                conn.execute("PRAGMA cache_size=-16000;")
                DatabaseManager._connections[db_key] = conn

        with lock:
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS reading_progress (
                    doc_path TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL DEFAULT '',
                    scroll_percent REAL NOT NULL DEFAULT 0.0,
                    scroll_top REAL NOT NULL DEFAULT 0.0,
                    heading_id TEXT NOT NULL DEFAULT '',
                    heading_text TEXT NOT NULL DEFAULT '',
                    is_completed INTEGER NOT NULL DEFAULT 0,
                    read_count INTEGER NOT NULL DEFAULT 1,
                    total_read_seconds INTEGER NOT NULL DEFAULT 0,
                    last_read_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS bookmarks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_path TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL DEFAULT '',
                    scroll_percent REAL NOT NULL DEFAULT 0.0,
                    heading_id TEXT NOT NULL DEFAULT '',
                    heading_text TEXT NOT NULL DEFAULT '',
                    snippet TEXT NOT NULL DEFAULT '',
                    memo TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT 'amber',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_bookmarks_doc ON bookmarks(doc_path);

                CREATE TABLE IF NOT EXISTS highlights (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_path TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL DEFAULT '',
                    selected_text TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT 'yellow',
                    heading_id TEXT NOT NULL DEFAULT '',
                    heading_text TEXT NOT NULL DEFAULT '',
                    scroll_percent REAL NOT NULL DEFAULT 0.0,
                    is_flashcard INTEGER NOT NULL DEFAULT 1,
                    mastered INTEGER NOT NULL DEFAULT 0,
                    review_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_highlights_doc ON highlights(doc_path);

                CREATE TABLE IF NOT EXISTS study_notes (
                    doc_path TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS study_daily_log (
                    study_date TEXT PRIMARY KEY,
                    study_seconds INTEGER NOT NULL DEFAULT 0,
                    pomodoro_count INTEGER NOT NULL DEFAULT 0,
                    quiz_solved_count INTEGER NOT NULL DEFAULT 0,
                    xp_earned INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS reader_settings (
                    profile_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS vault_doc_cache (
                    vault_root TEXT NOT NULL,
                    doc_path TEXT NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    meta_json TEXT NOT NULL,
                    raw_body TEXT NOT NULL,
                    search_text TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (vault_root, doc_path)
                );

                CREATE INDEX IF NOT EXISTS idx_vault_cache_root ON vault_doc_cache(vault_root);
                """
            )
            # 2026-11-13: 여러 번 완독 지원 — completed_count(완독 횟수), pass_seconds(이번 회차 읽은 시간)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(reading_progress)")}
            if "completed_count" not in cols:
                conn.execute("ALTER TABLE reading_progress ADD COLUMN completed_count INTEGER NOT NULL DEFAULT 0")
                conn.execute("UPDATE reading_progress SET completed_count = 1 WHERE is_completed = 1")
            if "pass_seconds" not in cols:
                conn.execute("ALTER TABLE reading_progress ADD COLUMN pass_seconds INTEGER NOT NULL DEFAULT 0")
            # 2026-11-14: 기기 간 동기화 — rev(저장할 때마다 +1), last_device(마지막으로 저장한 기기)
            if "rev" not in cols:
                conn.execute("ALTER TABLE reading_progress ADD COLUMN rev INTEGER NOT NULL DEFAULT 0")
            if "last_device" not in cols:
                conn.execute("ALTER TABLE reading_progress ADD COLUMN last_device TEXT NOT NULL DEFAULT ''")
            # 2026-11-14: read_ts — 그 위치를 실제로 읽은 시각(서버 시계 기준 ms). 인터넷이 끊겨 늦게 도착한 저장의 선후 판단용
            if "read_ts" not in cols:
                conn.execute("ALTER TABLE reading_progress ADD COLUMN read_ts INTEGER NOT NULL DEFAULT 0")

    @staticmethod
    def _now() -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _today() -> str:
        return datetime.now().strftime("%Y-%m-%d")

    def _record_daily_activity(
        self,
        conn: sqlite3.Connection,
        add_seconds: int = 0,
        add_pomodoro: int = 0,
        add_quiz: int = 0,
        add_xp: int = 0,
    ) -> None:
        today = self._today()
        now = self._now()
        sec = max(0, int(add_seconds))
        pomo = max(0, int(add_pomodoro))
        quiz = max(0, int(add_quiz))
        xp = max(0, int(add_xp)) + (sec // 12) + (pomo * 100) + (quiz * 10)
        conn.execute(
            """
            INSERT INTO study_daily_log (
                study_date, study_seconds, pomodoro_count, quiz_solved_count, xp_earned, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(study_date) DO UPDATE SET
                study_seconds = study_seconds + excluded.study_seconds,
                pomodoro_count = pomodoro_count + excluded.pomodoro_count,
                quiz_solved_count = quiz_solved_count + excluded.quiz_solved_count,
                xp_earned = xp_earned + excluded.xp_earned,
                updated_at = excluded.updated_at
            """,
            (today, sec, pomo, quiz, xp, now),
        )

    COMPLETE_AT = 96.0      # 이 이상 내려가면 이번 회차 완독
    RESTART_BELOW = 15.0    # 완독한 문서를 이보다 위에서 읽으면 새 회차 시작
    MIN_PASS_SECONDS = 60   # 다시 읽기 회차를 1회 완독으로 세려면 최소 이만큼 읽어야 함

    def save_progress(
        self,
        doc_path: str,
        title: str = "",
        folder: str = "",
        scroll_percent: float = 0.0,
        scroll_top: float = 0.0,
        heading_id: str = "",
        heading_text: str = "",
        is_completed: Optional[bool] = None,
        add_seconds: int = 0,
        device_id: str = "",
        base_rev: Optional[int] = None,
        read_ts: Optional[int] = None,
        queued: bool = False,
    ) -> Dict[str, Any]:
        """base_rev: 이 기기가 알고 있는 마지막 rev. 그 뒤에 다른 기기가 저장했으면 위치는 바꾸지 않고
        (읽은 시간만 더함) conflict=True 와 최신 진도를 돌려준다 → 기기는 최신 위치로 이동."""
        scroll_percent = max(0.0, min(100.0, round(float(scroll_percent), 1)))
        now = self._now()
        clean_sec = max(0, int(add_seconds))
        server_ms = int(time.time() * 1000)
        # 기기가 보낸 "읽은 시각"(서버 시계로 보정된 값). 없거나 미래면 지금
        ts = min(int(read_ts), server_ms) if read_ts else server_ms

        with self._get_conn() as conn:
            existing = conn.execute(
                "SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)
            ).fetchone()

            newly_completed = False
            counted = False
            ex_ts = int(existing["read_ts"] or 0) if existing else 0
            if existing and read_ts and (existing["last_device"] or "") == device_id and ex_ts == ts:
                # 같은 저장이 두 번 도착(앱이 닫히며 보낸 것 + 다시 보내기) → 한 번만 반영
                return dict(existing)
            if read_ts and ex_ts and ts < ex_ts:
                # 이미 더 나중에 읽은 기록이 있음 → 늦게 도착한 예전 저장은 위치를 바꾸지 않음
                stale = True
            elif (
                existing
                and base_rev is not None
                and int(existing["rev"] or 0) > int(base_rev)
                and (existing["last_device"] or "") not in ("", device_id)
            ):
                # 이 기기가 모르는 사이 다른 기기가 저장함. 인터넷이 끊겨 보관했다 다시 보낸 저장(queued)이
                # 실제로 더 나중에 읽은 것이면 그것이 최신. 접속 중인 기기의 저장이면 먼저 최신 위치를 따라가야 함
                stale = not (queued and read_ts and ts > ex_ts)
            else:
                stale = False
            if stale:
                conn.execute(
                    "UPDATE reading_progress SET total_read_seconds = total_read_seconds + ?, pass_seconds = pass_seconds + ? WHERE doc_path = ?",
                    (clean_sec, clean_sec, doc_path),
                )
                if clean_sec > 0:
                    self._record_daily_activity(conn, add_seconds=clean_sec, add_xp=2)
                row = conn.execute("SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)).fetchone()
                out = dict(row)
                out["conflict"] = True
                return out
            if existing:
                pass_sec = int(existing["pass_seconds"] or 0) + clean_sec
                count = int(existing["completed_count"] or 0)
                if is_completed is not None:
                    completed_val = int(is_completed)
                elif existing["is_completed"] and scroll_percent < self.RESTART_BELOW:
                    # 완독한 문서를 처음 부분부터 다시 읽기 시작 → 새 회차(완독 횟수는 그대로)
                    completed_val = 0
                    pass_sec = clean_sec
                elif not existing["is_completed"] and scroll_percent >= self.COMPLETE_AT:
                    completed_val = 1
                else:
                    completed_val = existing["is_completed"]
                if completed_val == 1 and existing["is_completed"] == 0:
                    # 다시 읽기 회차는 실제로 읽은 시간이 있어야 1회로 셈(맨 아래로 휙 내리기만 한 경우 제외)
                    if count == 0 or pass_sec >= self.MIN_PASS_SECONDS or is_completed:
                        count += 1
                        counted = True
                    newly_completed = counted
                # 같은 기기가 같은 위치를 다시 저장(읽은 시간만 늘어남)하면 버전을 올리지 않음
                # → 다른 기기가 그 사이 정상적으로 이어 읽은 저장이 "뒤처졌다"고 거절되지 않게
                same_spot = (
                    (existing["last_device"] or "") == device_id
                    and abs(float(existing["scroll_percent"]) - scroll_percent) < 0.5
                    and completed_val == existing["is_completed"]
                )
                bump = 0 if same_spot else 1
                new_title = title or existing["title"]
                new_folder = folder or existing["folder"]
                total_sec = existing["total_read_seconds"] + clean_sec

                conn.execute(
                    """
                    UPDATE reading_progress
                    SET title = ?,
                        folder = ?,
                        scroll_percent = ?,
                        scroll_top = ?,
                        heading_id = ?,
                        heading_text = ?,
                        is_completed = ?,
                        total_read_seconds = ?,
                        completed_count = ?,
                        pass_seconds = ?,
                        last_read_at = ?,
                        rev = rev + ?,
                        last_device = ?,
                        read_ts = ?
                    WHERE doc_path = ?
                    """,
                    (
                        new_title,
                        new_folder,
                        scroll_percent,
                        scroll_top,
                        heading_id,
                        heading_text,
                        completed_val,
                        total_sec,
                        count,
                        pass_sec,
                        now,
                        bump,
                        device_id,
                        ts,
                        doc_path,
                    ),
                )
            else:
                completed_val = (
                    int(is_completed)
                    if is_completed is not None
                    else (1 if scroll_percent >= 96.0 else 0)
                )
                if completed_val == 1:
                    newly_completed = True
                conn.execute(
                    """
                    INSERT INTO reading_progress (
                        doc_path, title, folder, scroll_percent, scroll_top,
                        heading_id, heading_text, is_completed, read_count,
                        total_read_seconds, last_read_at, completed_count, pass_seconds, rev, last_device, read_ts
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        doc_path,
                        title or Path(doc_path).stem,
                        folder,
                        scroll_percent,
                        scroll_top,
                        heading_id,
                        heading_text,
                        completed_val,
                        clean_sec,
                        now,
                        completed_val,
                        clean_sec,
                        device_id,
                        ts,
                    ),
                )

            if clean_sec > 0 or newly_completed:
                self._record_daily_activity(
                    conn,
                    add_seconds=clean_sec,
                    add_xp=50 if newly_completed else 2,
                )

            row = conn.execute(
                "SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)
            ).fetchone()
            return dict(row)

    def toggle_completed(self, doc_path: str, title: str = "", folder: str = "", device_id: str = "") -> Dict[str, Any]:
        now = self._now()
        with self._get_conn() as conn:
            existing = conn.execute(
                "SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)
            ).fetchone()
            if existing:
                new_state = 0 if existing["is_completed"] else 1
                new_pct = 100.0 if new_state == 1 and existing["scroll_percent"] < 95.0 else existing["scroll_percent"]
                count = int(existing["completed_count"] or 0)
                count = count + 1 if new_state == 1 else max(0, count - 1)   # 완독 표시 = 1회 추가, 해제 = 1회 취소
                conn.execute(
                    """
                    UPDATE reading_progress
                    SET is_completed = ?, scroll_percent = ?, completed_count = ?, pass_seconds = 0, last_read_at = ?,
                        rev = rev + 1, last_device = ?, read_ts = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                    WHERE doc_path = ?
                    """,
                    (new_state, new_pct, count, now, device_id, doc_path),
                )
                if new_state == 1:
                    self._record_daily_activity(conn, add_xp=50)
            else:
                conn.execute(
                    """
                    INSERT INTO reading_progress (
                        doc_path, title, folder, scroll_percent, scroll_top,
                        heading_id, heading_text, is_completed, read_count,
                        total_read_seconds, last_read_at, completed_count, pass_seconds, rev, last_device
                    ) VALUES (?, ?, ?, 100.0, 0.0, '', '', 1, 1, 0, ?, 1, 0, 1, ?)
                    """,
                    (doc_path, title or Path(doc_path).stem, folder, now, device_id),
                )
                self._record_daily_activity(conn, add_xp=50)
            row = conn.execute(
                "SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)
            ).fetchone()
            return dict(row)

    def restart_reading(self, doc_path: str, device_id: str = "") -> Optional[Dict[str, Any]]:
        """완독한 문서를 처음부터 다시 읽기: 위치 0, 새 회차 시작(완독 횟수는 유지)."""
        with self._get_conn() as conn:
            conn.execute(
                """
                UPDATE reading_progress
                SET is_completed = 0, scroll_percent = 0.0, scroll_top = 0.0, heading_id = '', heading_text = '',
                    pass_seconds = 0, last_read_at = ?, rev = rev + 1, last_device = ?, read_ts = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                WHERE doc_path = ?
                """,
                (self._now(), device_id, doc_path),
            )
            row = conn.execute("SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)).fetchone()
            return dict(row) if row else None

    def get_progress(self, doc_path: str) -> Optional[Dict[str, Any]]:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM reading_progress WHERE doc_path = ?", (doc_path,)
            ).fetchone()
            return dict(row) if row else None

    def get_all_progress_map(self) -> Dict[str, Dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM reading_progress ORDER BY last_read_at DESC"
            ).fetchall()
            return {r["doc_path"]: dict(r) for r in rows}

    def get_recent_reads(self, limit: int = 12) -> List[Dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM reading_progress ORDER BY last_read_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    # =========================================================================
    # Bookmarks
    # =========================================================================
    def add_bookmark(
        self,
        doc_path: str,
        title: str = "",
        folder: str = "",
        scroll_percent: float = 0.0,
        heading_id: str = "",
        heading_text: str = "",
        snippet: str = "",
        memo: str = "",
        color: str = "amber",
    ) -> Dict[str, Any]:
        now = self._now()
        scroll_percent = max(0.0, min(100.0, round(float(scroll_percent), 1)))
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO bookmarks (
                    doc_path, title, folder, scroll_percent, heading_id,
                    heading_text, snippet, memo, color, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doc_path,
                    title or Path(doc_path).stem,
                    folder,
                    scroll_percent,
                    heading_id,
                    heading_text,
                    snippet[:500],
                    memo[:1000],
                    color or "amber",
                    now,
                ),
            )
            self._record_daily_activity(conn, add_xp=15)
            row = conn.execute(
                "SELECT * FROM bookmarks WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return dict(row)

    def update_bookmark(self, bookmark_id: int, memo: str, color: str = "amber") -> Optional[Dict[str, Any]]:
        with self._get_conn() as conn:
            conn.execute(
                "UPDATE bookmarks SET memo = ?, color = ? WHERE id = ?",
                (memo[:1000], color or "amber", bookmark_id),
            )
            row = conn.execute(
                "SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)
            ).fetchone()
            return dict(row) if row else None

    def delete_bookmark(self, bookmark_id: int) -> bool:
        with self._get_conn() as conn:
            cur = conn.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
            return cur.rowcount > 0

    def get_bookmarks(self, doc_path: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_conn() as conn:
            if doc_path:
                rows = conn.execute(
                    "SELECT * FROM bookmarks WHERE doc_path = ? ORDER BY scroll_percent ASC, id DESC",
                    (doc_path,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM bookmarks ORDER BY created_at DESC, id DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    # =========================================================================
    # Highlights & Study Flashcards
    # =========================================================================
    def add_highlight(
        self,
        doc_path: str,
        selected_text: str,
        title: str = "",
        folder: str = "",
        note: str = "",
        color: str = "yellow",
        heading_id: str = "",
        heading_text: str = "",
        scroll_percent: float = 0.0,
        is_flashcard: bool = True,
    ) -> Dict[str, Any]:
        now = self._now()
        scroll_percent = max(0.0, min(100.0, round(float(scroll_percent), 1)))
        with self._get_conn() as conn:
            cur = conn.execute(
                """
                INSERT INTO highlights (
                    doc_path, title, folder, selected_text, note, color,
                    heading_id, heading_text, scroll_percent, is_flashcard,
                    mastered, review_count, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
                """,
                (
                    doc_path,
                    title or Path(doc_path).stem,
                    folder,
                    selected_text.strip()[:1000],
                    note.strip()[:1500],
                    color or "yellow",
                    heading_id,
                    heading_text,
                    scroll_percent,
                    1 if is_flashcard else 0,
                    now,
                ),
            )
            self._record_daily_activity(conn, add_xp=20)
            row = conn.execute("SELECT * FROM highlights WHERE id = ?", (cur.lastrowid,)).fetchone()
            return dict(row)

    def update_highlight(
        self,
        hl_id: int,
        note: Optional[str] = None,
        color: Optional[str] = None,
        mastered: Optional[bool] = None,
        increment_review: bool = False,
    ) -> Optional[Dict[str, Any]]:
        with self._get_conn() as conn:
            existing = conn.execute("SELECT * FROM highlights WHERE id = ?", (hl_id,)).fetchone()
            if not existing:
                return None
            new_note = note[:1500] if note is not None else existing["note"]
            new_color = color if color is not None else existing["color"]
            new_mastered = int(mastered) if mastered is not None else existing["mastered"]
            new_review = existing["review_count"] + (1 if increment_review else 0)
            conn.execute(
                """
                UPDATE highlights
                SET note = ?, color = ?, mastered = ?, review_count = ?
                WHERE id = ?
                """,
                (new_note, new_color, new_mastered, new_review, hl_id),
            )
            if increment_review or mastered:
                self._record_daily_activity(conn, add_quiz=1, add_xp=15)
            row = conn.execute("SELECT * FROM highlights WHERE id = ?", (hl_id,)).fetchone()
            return dict(row)

    def delete_highlight(self, hl_id: int) -> bool:
        with self._get_conn() as conn:
            cur = conn.execute("DELETE FROM highlights WHERE id = ?", (hl_id,))
            return cur.rowcount > 0

    def get_highlights(self, doc_path: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_conn() as conn:
            if doc_path:
                rows = conn.execute(
                    "SELECT * FROM highlights WHERE doc_path = ? ORDER BY scroll_percent ASC, id DESC",
                    (doc_path,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM highlights ORDER BY created_at DESC, id DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    # =========================================================================
    # Per-Document Study Scratchpad Note
    # =========================================================================
    def get_study_note(self, doc_path: str) -> Dict[str, Any]:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM study_notes WHERE doc_path = ?", (doc_path,)
            ).fetchone()
            if row:
                return dict(row)
            return {
                "doc_path": doc_path,
                "title": Path(doc_path).stem,
                "folder": "",
                "content": "",
                "updated_at": "",
            }

    def save_study_note(self, doc_path: str, content: str, title: str = "", folder: str = "") -> Dict[str, Any]:
        now = self._now()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO study_notes (doc_path, title, folder, content, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(doc_path) DO UPDATE SET
                    title = excluded.title,
                    folder = excluded.folder,
                    content = excluded.content,
                    updated_at = excluded.updated_at
                """,
                (doc_path, title or Path(doc_path).stem, folder, content[:30000], now),
            )
            self._record_daily_activity(conn, add_xp=5)
            row = conn.execute("SELECT * FROM study_notes WHERE doc_path = ?", (doc_path,)).fetchone()
            return dict(row)

    def get_all_study_notes(self) -> List[Dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM study_notes WHERE TRIM(content) != '' ORDER BY updated_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    # =========================================================================
    # Study Gamification Stats (Level, XP, Streak, Pomodoro, Daily Log)
    # =========================================================================
    def log_study_activity(
        self,
        add_seconds: int = 0,
        add_pomodoro: int = 0,
        add_quiz: int = 0,
        add_xp: int = 0,
    ) -> Dict[str, Any]:
        with self._get_conn() as conn:
            self._record_daily_activity(
                conn,
                add_seconds=add_seconds,
                add_pomodoro=add_pomodoro,
                add_quiz=add_quiz,
                add_xp=add_xp,
            )
        return self.get_study_stats()

    def get_study_stats(self) -> Dict[str, Any]:
        today_str = self._today()
        with self._get_conn() as conn:
            daily_rows = conn.execute(
                "SELECT * FROM study_daily_log ORDER BY study_date DESC"
            ).fetchall()
            daily_map = {r["study_date"]: dict(r) for r in daily_rows}

            prog_stats = conn.execute(
                """
                SELECT
                    COUNT(*) as touched_docs,
                    SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed_docs,
                    SUM(total_read_seconds) as total_read_sec
                FROM reading_progress
                """
            ).fetchone()

            bm_count = conn.execute("SELECT COUNT(*) as c FROM bookmarks").fetchone()["c"]
            hl_stats = conn.execute(
                """
                SELECT
                    COUNT(*) as total_hl,
                    SUM(CASE WHEN mastered = 1 THEN 1 ELSE 0 END) as mastered_hl
                FROM highlights
                """
            ).fetchone()

        today_row = daily_map.get(
            today_str,
            {"study_seconds": 0, "pomodoro_count": 0, "quiz_solved_count": 0, "xp_earned": 0},
        )

        # Calculate streak days
        streak = 0
        cursor_date = datetime.now().date()
        if cursor_date.strftime("%Y-%m-%d") not in daily_map:
            yesterday = (cursor_date - timedelta(days=1)).strftime("%Y-%m-%d")
            if yesterday in daily_map:
                cursor_date = cursor_date - timedelta(days=1)

        while cursor_date.strftime("%Y-%m-%d") in daily_map:
            row = daily_map[cursor_date.strftime("%Y-%m-%d")]
            if row["study_seconds"] > 0 or row["xp_earned"] > 0 or row["pomodoro_count"] > 0 or row["quiz_solved_count"] > 0:
                streak += 1
                cursor_date = cursor_date - timedelta(days=1)
            else:
                break

        if streak == 0 and (prog_stats["touched_docs"] or 0) > 0:
            streak = 1

        logged_xp = sum(r["xp_earned"] for r in daily_rows)
        completed_docs = int(prog_stats["completed_docs"] or 0)
        total_hl = int(hl_stats["total_hl"] or 0)
        mastered_hl = int(hl_stats["mastered_hl"] or 0)
        total_read_sec = max(
            int(prog_stats["total_read_sec"] or 0),
            sum(r["study_seconds"] for r in daily_rows),
        )

        base_xp = (completed_docs * 50) + (bm_count * 15) + (total_hl * 20) + (mastered_hl * 15) + (total_read_sec // 12)
        total_xp = max(logged_xp, base_xp)

        # Level calculation: 200 XP per level
        level = max(1, (total_xp // 200) + 1)
        xp_in_level = total_xp % 200
        level_progress_pct = round((xp_in_level / 200) * 100, 1)

        level_title = LEVEL_TITLES[0][1]
        for req_lv, t_name in LEVEL_TITLES:
            if level >= req_lv:
                level_title = t_name

        total_pomodoros = sum(r["pomodoro_count"] for r in daily_rows)
        total_quizzes = sum(r["quiz_solved_count"] for r in daily_rows)

        return {
            "level": level,
            "level_title": level_title,
            "total_xp": total_xp,
            "xp_in_level": xp_in_level,
            "xp_for_next_level": 200,
            "level_progress_pct": level_progress_pct,
            "streak_days": streak,
            "today_minutes": max(1 if today_row["xp_earned"] > 0 else 0, round(today_row["study_seconds"] / 60)),
            "total_minutes": round(total_read_sec / 60),
            "today_pomodoros": today_row["pomodoro_count"],
            "total_pomodoros": total_pomodoros,
            "today_quizzes": today_row["quiz_solved_count"],
            "total_quizzes": total_quizzes,
            "total_highlights": total_hl,
            "mastered_highlights": mastered_hl,
        }

    # =========================================================================
    # Reader Typography & Eye-Comfort Settings
    # =========================================================================
    def get_reader_settings(self, profile_id: str = "default") -> Dict[str, Any]:
        cache_key = f"{self.db_path}::{profile_id}"
        if cache_key in DatabaseManager._settings_cache and self.db_path.exists():
            return dict(DatabaseManager._settings_cache[cache_key])

        default_settings = {
            "theme": "warm_paper",       # warm_paper | forest | sepia | soft_light | dark | deep_forest | eink
            "fontFamily": "ridi",        # ridi | maru | serif | sans | mono
            "fontSize": 18,              # 14 ~ 28 px
            "lineHeight": 1.9,           # 1.4 ~ 2.4
            "paraSpacing": 1.3,          # paragraph spacing em
            "maxWidth": "820px",         # 680px | 820px | 1020px | 100%
            "viewMode": "scroll",        # scroll | paginated
            "eyeCareFilter": 0,          # 0 ~ 35 warm amber filter overlay
            "showSubtitle": True,        # show frontmatter/H1 subtitle next to actual filename
            "autoRestoreScroll": True,
            "zenMode": False,
        }
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT settings_json FROM reader_settings WHERE profile_id = ?",
                (profile_id,),
            ).fetchone()
            if row:
                try:
                    saved = json.loads(row["settings_json"])
                    default_settings.update(saved)
                except Exception:
                    pass
        DatabaseManager._settings_cache[cache_key] = dict(default_settings)
        return default_settings

    def save_reader_settings(self, settings: Dict[str, Any], profile_id: str = "default") -> Dict[str, Any]:
        cache_key = f"{self.db_path}::{profile_id}"
        current = self.get_reader_settings(profile_id)
        current.update(settings)
        now = self._now()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO reader_settings (profile_id, settings_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                    settings_json = excluded.settings_json,
                    updated_at = excluded.updated_at
                """,
                (profile_id, json.dumps(current, ensure_ascii=False), now),
            )
        DatabaseManager._settings_cache[cache_key] = dict(current)
        return current

    # =========================================================================
    # Persistent Vault Document Index Cache (SQLite L2 Cache)
    # =========================================================================
    def load_vault_cache(self, vault_root: str) -> Dict[str, Dict[str, Any]]:
        result: Dict[str, Dict[str, Any]] = {}
        try:
            with self._get_conn() as conn:
                rows = conn.execute(
                    """
                    SELECT doc_path, mtime_ns, size_bytes, meta_json, raw_body, search_text
                    FROM vault_doc_cache
                    WHERE vault_root = ?
                    """,
                    (vault_root,),
                ).fetchall()
                for r in rows:
                    try:
                        meta = json.loads(r["meta_json"])
                        result[r["doc_path"]] = {
                            "mtime_ns": int(r["mtime_ns"]),
                            "size_bytes": int(r["size_bytes"]),
                            "meta": meta,
                            "raw_body": r["raw_body"],
                            "search_text": r["search_text"],
                        }
                    except Exception:
                        continue
        except Exception:
            pass
        return result

    def save_vault_cache_batch(
        self,
        vault_root: str,
        upserts: List[Dict[str, Any]],
        deleted_paths: List[str],
    ) -> None:
        if not upserts and not deleted_paths:
            return
        now = self._now()
        try:
            with self._get_conn() as conn:
                if deleted_paths:
                    conn.executemany(
                        "DELETE FROM vault_doc_cache WHERE vault_root = ? AND doc_path = ?",
                        [(vault_root, p) for p in deleted_paths],
                    )
                if upserts:
                    conn.executemany(
                        """
                        INSERT INTO vault_doc_cache (
                            vault_root, doc_path, mtime_ns, size_bytes,
                            meta_json, raw_body, search_text, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(vault_root, doc_path) DO UPDATE SET
                            mtime_ns = excluded.mtime_ns,
                            size_bytes = excluded.size_bytes,
                            meta_json = excluded.meta_json,
                            raw_body = excluded.raw_body,
                            search_text = excluded.search_text,
                            updated_at = excluded.updated_at
                        """,
                        [
                            (
                                vault_root,
                                item["doc_path"],
                                int(item["mtime_ns"]),
                                int(item["size_bytes"]),
                                json.dumps(item["meta"], ensure_ascii=False),
                                item["raw_body"],
                                item["search_text"],
                                now,
                            )
                            for item in upserts
                        ],
                    )
        except Exception:
            pass
