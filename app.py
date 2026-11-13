import hashlib
import hmac
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from modules.config import (
    BASE_DIR,
    VAULT_PATH,
    DB_PATH,
    APP_PASSWORD,
    APP_SECRET,
    VAULT_TITLE,
    APP_PORT,
)
from modules.db_manager import DatabaseManager
from modules.vault_scanner import VaultScanner, get_optimized_asset_payload
from modules.tunnel_manager import tunnel_manager


def get_db() -> DatabaseManager:
    return DatabaseManager(DB_PATH)


def get_scanner() -> VaultScanner:
    return VaultScanner(VAULT_PATH, DB_PATH)


def get_effective_password() -> str:
    db = get_db()
    settings = db.get_reader_settings()
    if "custom_password" in settings and settings["custom_password"] is not None:
        return str(settings["custom_password"]).strip()
    return APP_PASSWORD


_watcher_stop_event = threading.Event()


def _background_vault_watcher():
    # 볼트 변경 감시 주기: 30초 → 120초 (변경 없는 동안의 불필요한 재스캔 부하 감소)
    while not _watcher_stop_event.wait(120.0):
        try:
            get_scanner().sync_index(force=True)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 1. Pre-warm the Persistent Vault Index on container startup so all requests are instant
    try:
        get_scanner().warm_up()
        _watcher_stop_event.clear()
        threading.Thread(target=_background_vault_watcher, daemon=True).start()
    except Exception:
        pass

    # 2. Auto-restore saved domain tunnel on production container startup
    # (Skip auto-starting tunnel during pytest or inside the local IDE workspace so it never hijacks production DNS)
    is_prod_container = str(BASE_DIR.resolve()) == "/app" or os.getenv("AUTO_START_TUNNEL", "") == "1"
    if is_prod_container and "pytest" not in sys.modules:
        try:
            db = get_db()
            saved = db.get_reader_settings()
            saved_domain = saved.get("cf_custom_domain", "")
            saved_token = saved.get("cf_tunnel_token", "")
            if saved_domain:
                tunnel_manager.custom_domain = saved_domain
            if tunnel_manager.tunnel_token or saved_token:
                tunnel_manager.start_token_tunnel(
                    tunnel_manager.tunnel_token or saved_token,
                    tunnel_manager.custom_domain,
                )
            elif tunnel_manager.check_cert_exists():
                tunnel_manager.provision_and_start_named_domain(tunnel_manager.custom_domain)
        except Exception:
            pass
    yield
    _watcher_stop_event.set()


app = FastAPI(
    title="ObsiBook — Obsidian Web E-Book & Study Workstation",
    description="100% Read-Only Cross-Device Web E-Book Reader & Interactive Study Hub for Obsidian Vaults",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=500)

STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _make_auth_token(password: str) -> str:
    return hmac.new(
        APP_SECRET.encode("utf-8"),
        password.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_auth(request: Request) -> bool:
    pwd = get_effective_password()
    if not pwd:
        return True
    cookie_token = request.cookies.get("obsibook_session", "")
    header_token = request.headers.get("X-ObsiBook-Token", "")
    expected = _make_auth_token(pwd)
    if (cookie_token and hmac.compare_digest(cookie_token, expected)) or (
        header_token and hmac.compare_digest(header_token, expected)
    ):
        return True
    raise HTTPException(status_code=401, detail="Authentication required")


class LoginPayload(BaseModel):
    password: str


class SetPasswordPayload(BaseModel):
    new_password: str = ""


class ProgressPayload(BaseModel):
    doc_path: str
    title: str = ""
    folder: str = ""
    scroll_percent: float = 0.0
    scroll_top: float = 0.0
    heading_id: str = ""
    heading_text: str = ""
    is_completed: Optional[bool] = None
    add_seconds: int = 0
    device_id: str = ""
    base_rev: Optional[int] = None


class ToggleCompletePayload(BaseModel):
    doc_path: str
    title: str = ""
    folder: str = ""
    device_id: str = ""


class BookmarkCreatePayload(BaseModel):
    doc_path: str
    title: str = ""
    folder: str = ""
    scroll_percent: float = 0.0
    heading_id: str = ""
    heading_text: str = ""
    snippet: str = ""
    memo: str = ""
    color: str = "amber"


class BookmarkUpdatePayload(BaseModel):
    memo: str = ""
    color: str = "amber"


class HighlightCreatePayload(BaseModel):
    doc_path: str
    selected_text: str
    title: str = ""
    folder: str = ""
    note: str = ""
    color: str = "yellow"
    heading_id: str = ""
    heading_text: str = ""
    scroll_percent: float = 0.0
    is_flashcard: bool = True


class HighlightUpdatePayload(BaseModel):
    note: Optional[str] = None
    color: Optional[str] = None
    mastered: Optional[bool] = None
    increment_review: bool = False


class StudyNotePayload(BaseModel):
    doc_path: str
    title: str = ""
    folder: str = ""
    content: str = ""


class StudyActivityPayload(BaseModel):
    add_seconds: int = 0
    add_pomodoro: int = 0
    add_quiz: int = 0
    add_xp: int = 0


class TunnelTokenPayload(BaseModel):
    token: str
    custom_domain: str = ""


class TunnelDomainPayload(BaseModel):
    custom_domain: str = ""


class TunnelCertPayload(BaseModel):
    cert_pem: str
    custom_domain: str = ""


@app.get("/")
def index_page():
    return FileResponse(
        str(STATIC_DIR / "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/manifest.json")
def manifest_file():
    return FileResponse(str(STATIC_DIR / "manifest.json"))


@app.get("/api/health")
def health_check():
    scanner = get_scanner()
    return {
        "status": "ok",
        "version": "3.0.0",
        "read_only": True,
        "vault_exists": scanner.vault_path.exists(),
        "vault_title": VAULT_TITLE,
    }


@app.get("/api/auth/status")
def auth_status(request: Request):
    pwd = get_effective_password()
    if not pwd:
        return {
            "requires_auth": False,
            "authenticated": True,
            "vault_title": VAULT_TITLE,
        }
    cookie_token = request.cookies.get("obsibook_session", "")
    header_token = request.headers.get("X-ObsiBook-Token", "")
    expected = _make_auth_token(pwd)
    is_authed = bool(
        (cookie_token and hmac.compare_digest(cookie_token, expected))
        or (header_token and hmac.compare_digest(header_token, expected))
    )
    return {
        "requires_auth": True,
        "authenticated": is_authed,
        "vault_title": VAULT_TITLE,
    }


@app.post("/api/auth/login")
def auth_login(payload: LoginPayload, response: Response):
    pwd = get_effective_password()
    if not pwd:
        return {"authenticated": True, "token": ""}
    if hmac.compare_digest(payload.password.strip(), pwd):
        token = _make_auth_token(pwd)
        response.set_cookie(
            key="obsibook_session",
            value=token,
            httponly=True,
            max_age=60 * 60 * 24 * 30,
            samesite="lax",
        )
        return {"authenticated": True, "token": token}
    raise HTTPException(status_code=401, detail="비밀번호가 일치하지 않습니다.")


@app.post("/api/auth/set-password")
def set_library_password(
    payload: SetPasswordPayload,
    response: Response,
    _: bool = Depends(verify_auth),
):
    db = get_db()
    clean_pwd = payload.new_password.strip()
    db.save_reader_settings({"custom_password": clean_pwd})
    if clean_pwd:
        token = _make_auth_token(clean_pwd)
        response.set_cookie(
            key="obsibook_session",
            value=token,
            httponly=True,
            max_age=60 * 60 * 24 * 30,
            samesite="lax",
        )
        return {"status": "password_enabled", "requires_auth": True, "token": token}
    else:
        response.delete_cookie("obsibook_session")
        return {"status": "password_disabled", "requires_auth": False, "token": ""}


@app.post("/api/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie("obsibook_session")
    return {"authenticated": False}


# =====================================================================
# 🌐 Built-in Cloudflare Domain & Tunnel Management Endpoints
# =====================================================================
@app.get("/api/tunnel/status")
def api_tunnel_status(_: bool = Depends(verify_auth)):
    st = tunnel_manager.get_status()
    st["password_enabled"] = bool(get_effective_password())
    return st


@app.post("/api/tunnel/quick")
def api_tunnel_quick(_: bool = Depends(verify_auth)):
    return tunnel_manager.start_quick_tunnel()


@app.post("/api/tunnel/token")
def api_tunnel_token(payload: TunnelTokenPayload, _: bool = Depends(verify_auth)):
    res = tunnel_manager.start_token_tunnel(payload.token, payload.custom_domain)
    if res.get("ok"):
        db = get_db()
        db.save_reader_settings(
            {
                "cf_tunnel_token": tunnel_manager.tunnel_token,
                "cf_custom_domain": tunnel_manager.custom_domain,
            }
        )
    return res


@app.post("/api/tunnel/login")
def api_tunnel_login(payload: TunnelDomainPayload, _: bool = Depends(verify_auth)):
    db = get_db()
    if payload.custom_domain.strip():
        db.save_reader_settings({"cf_custom_domain": payload.custom_domain.strip()})
    return tunnel_manager.start_cloudflare_login_flow(payload.custom_domain)


@app.post("/api/tunnel/cert")
def api_tunnel_cert(payload: TunnelCertPayload, _: bool = Depends(verify_auth)):
    db = get_db()
    if payload.custom_domain.strip():
        db.save_reader_settings({"cf_custom_domain": payload.custom_domain.strip()})
    return tunnel_manager.save_uploaded_cert(payload.cert_pem, payload.custom_domain)


@app.post("/api/tunnel/stop")
def api_tunnel_stop(_: bool = Depends(verify_auth)):
    tunnel_manager.stop_tunnel()
    return {"ok": True, **tunnel_manager.get_status()}


# =====================================================================
# 📚 Library, Folder Hierarchy & Document Endpoints
# =====================================================================
def _build_library_response(force_rescan: bool = False) -> dict:
    db = get_db()
    scanner = get_scanner()
    progress_map = db.get_all_progress_map()
    tree = scanner.build_vault_tree(
        progress_map=progress_map,
        force_rescan=force_rescan,
        use_ttl=not force_rescan,
    )
    recent_reads = db.get_recent_reads(limit=12)
    existing_map = {d["path"]: d for d in tree["documents"]}

    valid_recent = []
    for r in recent_reads:
        if r["doc_path"] in existing_map:
            doc_obj = existing_map[r["doc_path"]]
            r["title"] = doc_obj["title"]
            r["subtitle"] = doc_obj.get("subtitle", "")
            r["folder"] = doc_obj["folder"] or doc_obj["top_folder"]
            valid_recent.append(r)

    bookmarks = []
    for b in db.get_bookmarks():
        if b["doc_path"] in existing_map:
            b["title"] = existing_map[b["doc_path"]]["title"]
            bookmarks.append(b)

    highlights = []
    for h in db.get_highlights():
        if h["doc_path"] in existing_map:
            h["title"] = existing_map[h["doc_path"]]["title"]
            highlights.append(h)

    study_notes = [
        n for n in db.get_all_study_notes() if n["doc_path"] in existing_map
    ]
    settings = db.get_reader_settings()
    study_stats = db.get_study_stats()

    # 완독 = 한 번이라도 완독(다시 읽는 중 포함), 읽는 중 = 아직 한 번도 완독 안 했고 읽은 적 있음
    completed_total = sum(1 for d in tree["documents"] if d.get("is_completed") or d.get("completed_count", 0) > 0)
    in_progress_total = sum(
        1
        for d in tree["documents"]
        if not (d.get("is_completed") or d.get("completed_count", 0) > 0) and d.get("scroll_percent", 0) > 0
    )

    return {
        "vault_title": VAULT_TITLE,
        "read_only_mode": True,
        "scan_ms": tree.get("scan_ms", 0),
        "stats": {
            "total_docs": tree["total_docs"],
            "total_folders": len(tree["directories"]),
            "top_folders": len(tree["folders"]),
            "completed_docs": completed_total,
            "in_progress_docs": in_progress_total,
            "total_bookmarks": len(bookmarks),
            "total_highlights": len(highlights),
        },
        "study_stats": study_stats,
        "folders": tree["folders"],
        "folder_tree": tree["folder_tree"],
        "directories": tree["directories"],
        "documents": tree["documents"],
        "tags": tree["tags"],
        "recent_reads": valid_recent,
        "bookmarks": bookmarks,
        "highlights": highlights,
        "study_notes": study_notes,
        "settings": settings,
        "tunnel": tunnel_manager.get_status(),
    }


@app.get("/api/library")
def get_library(rescan: bool = False, _: bool = Depends(verify_auth)):
    return _build_library_response(force_rescan=rescan)


@app.post("/api/library/rescan")
def rescan_library(_: bool = Depends(verify_auth)):
    return _build_library_response(force_rescan=True)


@app.get("/api/docs/preload")
def preload_documents(
    offset: int = 0,
    limit: int = 40,
    _: bool = Depends(verify_auth),
):
    scanner = get_scanner()
    safe_offset = max(0, offset)
    safe_limit = min(80, max(1, limit))
    return scanner.get_documents_batch(offset=safe_offset, limit=safe_limit)


@app.get("/api/doc")
def get_document(path: str, _: bool = Depends(verify_auth)):
    scanner = get_scanner()
    doc = scanner.get_document(path)
    if not doc:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    db = get_db()
    progress = db.get_progress(doc["path"])
    doc_bookmarks = db.get_bookmarks(doc["path"])
    doc_highlights = db.get_highlights(doc["path"])
    doc_study_note = db.get_study_note(doc["path"])

    doc["progress"] = progress or {
        "doc_path": doc["path"],
        "scroll_percent": 0.0,
        "scroll_top": 0.0,
        "heading_id": "",
        "heading_text": "",
        "is_completed": 0,
        "last_read_at": "",
    }
    doc["bookmarks"] = doc_bookmarks
    doc["highlights"] = doc_highlights
    doc["study_note"] = doc_study_note
    return doc


@app.post("/api/progress")
def save_reading_progress(payload: ProgressPayload, _: bool = Depends(verify_auth)):
    db = get_db()
    saved = db.save_progress(
        doc_path=payload.doc_path,
        title=payload.title,
        folder=payload.folder,
        scroll_percent=payload.scroll_percent,
        scroll_top=payload.scroll_top,
        heading_id=payload.heading_id,
        heading_text=payload.heading_text,
        is_completed=payload.is_completed,
        add_seconds=payload.add_seconds,
        device_id=payload.device_id,
        base_rev=payload.base_rev,
    )
    conflict = bool(saved.pop("conflict", False))
    return {"status": "conflict" if conflict else "saved", "conflict": conflict, "progress": saved, "study_stats": db.get_study_stats()}


@app.post("/api/progress/toggle-complete")
def toggle_doc_complete(payload: ToggleCompletePayload, _: bool = Depends(verify_auth)):
    db = get_db()
    updated = db.toggle_completed(
        doc_path=payload.doc_path,
        title=payload.title,
        folder=payload.folder,
        device_id=payload.device_id,
    )
    return {"status": "updated", "progress": updated, "study_stats": db.get_study_stats()}


class RestartPayload(BaseModel):
    doc_path: str
    device_id: str = ""


@app.post("/api/progress/restart")
def restart_doc_reading(payload: RestartPayload, _: bool = Depends(verify_auth)):
    """완독한 문서를 처음부터 다시 읽기(완독 횟수는 유지)."""
    db = get_db()
    return {"status": "restarted", "progress": db.restart_reading(payload.doc_path, payload.device_id)}


@app.get("/api/progress")
def get_doc_progress(doc_path: str, _: bool = Depends(verify_auth)):
    """다른 기기에서 읽은 최신 위치 확인용(가벼운 조회)."""
    return {"progress": get_db().get_progress(doc_path)}


# =====================================================================
# 🔖 Bookmarks Endpoints
# =====================================================================
@app.get("/api/bookmarks")
def list_bookmarks(doc_path: Optional[str] = None, _: bool = Depends(verify_auth)):
    db = get_db()
    return {"bookmarks": db.get_bookmarks(doc_path=doc_path)}


@app.post("/api/bookmarks")
def create_bookmark(payload: BookmarkCreatePayload, _: bool = Depends(verify_auth)):
    db = get_db()
    bm = db.add_bookmark(
        doc_path=payload.doc_path,
        title=payload.title,
        folder=payload.folder,
        scroll_percent=payload.scroll_percent,
        heading_id=payload.heading_id,
        heading_text=payload.heading_text,
        snippet=payload.snippet,
        memo=payload.memo,
        color=payload.color,
    )
    return {"status": "created", "bookmark": bm, "study_stats": db.get_study_stats()}


@app.put("/api/bookmarks/{bookmark_id}")
def edit_bookmark(
    bookmark_id: int,
    payload: BookmarkUpdatePayload,
    _: bool = Depends(verify_auth),
):
    db = get_db()
    updated = db.update_bookmark(bookmark_id, memo=payload.memo, color=payload.color)
    if not updated:
        raise HTTPException(status_code=404, detail="책갈피를 찾을 수 없습니다.")
    return {"status": "updated", "bookmark": updated}


@app.delete("/api/bookmarks/{bookmark_id}")
def remove_bookmark(bookmark_id: int, _: bool = Depends(verify_auth)):
    db = get_db()
    deleted = db.delete_bookmark(bookmark_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="책갈피를 찾을 수 없습니다.")
    return {"status": "deleted", "id": bookmark_id}


# =====================================================================
# 🖍️ Highlights & Flashcards Endpoints
# =====================================================================
@app.get("/api/highlights")
def list_highlights(doc_path: Optional[str] = None, _: bool = Depends(verify_auth)):
    db = get_db()
    return {"highlights": db.get_highlights(doc_path=doc_path)}


@app.post("/api/highlights")
def create_highlight(payload: HighlightCreatePayload, _: bool = Depends(verify_auth)):
    db = get_db()
    hl = db.add_highlight(
        doc_path=payload.doc_path,
        selected_text=payload.selected_text,
        title=payload.title,
        folder=payload.folder,
        note=payload.note,
        color=payload.color,
        heading_id=payload.heading_id,
        heading_text=payload.heading_text,
        scroll_percent=payload.scroll_percent,
        is_flashcard=payload.is_flashcard,
    )
    return {"status": "created", "highlight": hl, "study_stats": db.get_study_stats()}


@app.put("/api/highlights/{hl_id}")
def edit_highlight(
    hl_id: int,
    payload: HighlightUpdatePayload,
    _: bool = Depends(verify_auth),
):
    db = get_db()
    updated = db.update_highlight(
        hl_id,
        note=payload.note,
        color=payload.color,
        mastered=payload.mastered,
        increment_review=payload.increment_review,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="하이라이트를 찾을 수 없습니다.")
    return {"status": "updated", "highlight": updated, "study_stats": db.get_study_stats()}


@app.delete("/api/highlights/{hl_id}")
def remove_highlight(hl_id: int, _: bool = Depends(verify_auth)):
    db = get_db()
    deleted = db.delete_highlight(hl_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="하이라이트를 찾을 수 없습니다.")
    return {"status": "deleted", "id": hl_id}


# =====================================================================
# ✏️ Per-Document Study Scratchpad & Study Gamification Endpoints
# =====================================================================
@app.get("/api/study-note")
def get_doc_study_note(doc_path: str, _: bool = Depends(verify_auth)):
    db = get_db()
    return {"study_note": db.get_study_note(doc_path)}


@app.post("/api/study-note")
def save_doc_study_note(payload: StudyNotePayload, _: bool = Depends(verify_auth)):
    db = get_db()
    saved = db.save_study_note(
        doc_path=payload.doc_path,
        content=payload.content,
        title=payload.title,
        folder=payload.folder,
    )
    return {"status": "saved", "study_note": saved, "study_stats": db.get_study_stats()}


@app.get("/api/study/stats")
def get_study_stats_api(_: bool = Depends(verify_auth)):
    db = get_db()
    return {"study_stats": db.get_study_stats()}


@app.post("/api/study/log")
def log_study_activity_api(payload: StudyActivityPayload, _: bool = Depends(verify_auth)):
    db = get_db()
    stats = db.log_study_activity(
        add_seconds=payload.add_seconds,
        add_pomodoro=payload.add_pomodoro,
        add_quiz=payload.add_quiz,
        add_xp=payload.add_xp,
    )
    return {"status": "logged", "study_stats": stats}


@app.get("/api/search")
def search_vault(
    q: str = "",
    folder: str = "",
    tag: str = "",
    _: bool = Depends(verify_auth),
):
    scanner = get_scanner()
    db = get_db()
    progress_map = db.get_all_progress_map()
    results = scanner.search(query=q, folder=folder, tag=tag)
    for r in results:
        p = progress_map.get(r["path"])
        r["scroll_percent"] = p["scroll_percent"] if p else 0.0
        r["is_completed"] = bool(p["is_completed"]) if p else False
        r["completed_count"] = int(p.get("completed_count") or 0) if p else 0
    return {"query": q, "folder": folder, "tag": tag, "results": results}


@app.get("/api/settings")
def get_settings(_: bool = Depends(verify_auth)):
    db = get_db()
    return {"settings": db.get_reader_settings()}


@app.post("/api/settings")
async def update_settings(request: Request, _: bool = Depends(verify_auth)):
    body = await request.json()
    db = get_db()
    saved = db.save_reader_settings(body if isinstance(body, dict) else {})
    return {"status": "saved", "settings": saved}


@app.get("/api/asset")
def serve_vault_asset(
    path: str,
    request: Request,
    raw: bool = False,
    _: bool = Depends(verify_auth),
):
    scanner = get_scanner()
    asset_path = scanner.find_asset_path(path)
    if not asset_path:
        raise HTTPException(status_code=404, detail="첨부 파일을 찾을 수 없습니다.")

    opt_bytes, mime_type, etag = get_optimized_asset_payload(asset_path, raw=raw)

    cache_headers = {
        "Cache-Control": "public, max-age=604800, immutable",
    }
    if etag:
        cache_headers["ETag"] = etag
        inm = request.headers.get("if-none-match", "")
        if inm and etag in inm:
            return Response(status_code=304, headers=cache_headers)

    if opt_bytes is not None:
        return Response(
            content=opt_bytes,
            media_type=mime_type,
            headers=cache_headers,
        )

    return FileResponse(
        str(asset_path),
        headers=cache_headers,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=APP_PORT, reload=False)
