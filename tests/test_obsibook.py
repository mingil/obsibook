from pathlib import Path
from fastapi.testclient import TestClient

import app as obsibook_app
from modules.db_manager import DatabaseManager
from modules.vault_scanner import VaultScanner
from modules.tunnel_manager import TunnelManager


def test_exact_filename_and_nested_folder_hierarchy(tmp_path: Path):
    vault = tmp_path / "vault"
    sub1 = vault / "Dr_Rehab_Master" / "01_해부학" / "상지"
    sub2 = vault / "Dr_Rehab_Master" / "02_신경재활"
    sub1.mkdir(parents=True)
    sub2.mkdir(parents=True)

    # Even if frontmatter title or H1 is different, doc["title"] MUST be the exact filename stem!
    md_file = sub1 / "01_어깨관절_생체역학.md"
    md_file.write_text(
        "---\n"
        "title: \"Frontmatter Different Title\"\n"
        "date: 2026-11-03\n"
        "tags: [rehab, shoulder]\n"
        "---\n"
        "# 1. 서론 (H1 Heading)\n"
        "Some intro text with ==highlighted core term== and #inline_tag and [[02_뇌졸중_가이드|Link Label]].\n\n"
        "## Section Two\n"
        "Details here.\n",
        encoding="utf-8",
    )

    other_file = sub2 / "02_뇌졸중_가이드.md"
    other_file.write_text("# 뇌졸중 재활\nHello world", encoding="utf-8")

    scanner = VaultScanner(vault)
    tree = scanner.build_vault_tree()

    assert tree["total_docs"] == 2
    assert "Dr_Rehab_Master" in tree["directories"]
    assert "Dr_Rehab_Master/01_해부학" in tree["directories"]
    assert "Dr_Rehab_Master/01_해부학/상지" in tree["directories"]
    assert "Dr_Rehab_Master/02_신경재활" in tree["directories"]

    # Top folder has 2 subfolders ('01_해부학', '02_신경재활') and 0 direct docs
    top_dir = tree["directories"]["Dr_Rehab_Master"]
    assert top_dir["subfolder_count"] == 2
    assert top_dir["direct_doc_count"] == 0
    assert top_dir["total_doc_count"] == 2

    # Leaf folder 'Dr_Rehab_Master/01_해부학/상지' has 1 direct doc
    leaf_dir = tree["directories"]["Dr_Rehab_Master/01_해부학/상지"]
    assert leaf_dir["direct_doc_count"] == 1
    assert leaf_dir["direct_docs"][0]["title"] == "01_어깨관절_생체역학"

    doc = scanner.get_document("Dr_Rehab_Master/01_해부학/상지/01_어깨관절_생체역학.md")
    assert doc is not None
    # Exact filename preserved (with underscores!)
    assert doc["title"] == "01_어깨관절_생체역학"
    assert doc["subtitle"] == "Frontmatter Different Title"
    assert len(doc["breadcrumbs"]) == 3
    assert doc["breadcrumbs"][-1]["path"] == "Dr_Rehab_Master/01_해부학/상지"
    assert '<mark class="obs-hl">highlighted core term</mark>' in doc["content"]
    assert "#doc:Dr_Rehab_Master/02_%EC%8B%A0%EA%B2%BD%EC%9E%AC%ED%99%9C/02_%EB%87%8C%EC%A1%B8%EC%A4%91_%EA%B0%80%EC%9D%B4%EB%93%9C.md" in doc["content"]


def test_path_traversal_blocked(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    outside = tmp_path / "secret.md"
    outside.write_text("Top secret", encoding="utf-8")

    scanner = VaultScanner(vault)
    assert scanner.get_document("../secret.md") is None


def test_cross_device_progress_bookmarks_highlights_and_study_stats(tmp_path: Path):
    db_file = tmp_path / "test_reader.db"
    db = DatabaseManager(db_file)

    # Save progress
    saved = db.save_progress(
        doc_path="AI_Prompts/prompt1.md",
        title="prompt1",
        folder="AI_Prompts",
        scroll_percent=42.5,
        scroll_top=680.0,
        heading_id="step-2",
        heading_text="Step 2",
        add_seconds=60,
    )
    assert saved["scroll_percent"] == 42.5
    assert saved["is_completed"] == 0

    # Auto complete when >= 96%
    completed = db.save_progress(
        doc_path="AI_Prompts/prompt1.md",
        scroll_percent=98.2,
    )
    assert completed["is_completed"] == 1

    # Add & list bookmark
    bm = db.add_bookmark(
        doc_path="AI_Prompts/prompt1.md",
        title="prompt1",
        folder="AI_Prompts",
        scroll_percent=42.5,
        heading_id="step-2",
        heading_text="Step 2",
        memo="Important clinical prompt",
        color="emerald",
    )
    assert bm["id"] > 0

    # Add highlight / flashcard
    hl = db.add_highlight(
        doc_path="AI_Prompts/prompt1.md",
        selected_text="Rotator cuff tear rehabilitation protocol",
        title="prompt1",
        folder="AI_Prompts",
        note="Key exam sentence",
        color="yellow",
        scroll_percent=50.0,
        is_flashcard=True,
    )
    assert hl["id"] > 0
    assert len(db.get_highlights("AI_Prompts/prompt1.md")) == 1

    updated_hl = db.update_highlight(hl["id"], mastered=True, increment_review=True)
    assert updated_hl["mastered"] == 1
    assert updated_hl["review_count"] == 1

    # Study note scratchpad
    sn = db.save_study_note("AI_Prompts/prompt1.md", "My summary note", title="prompt1", folder="AI_Prompts")
    assert sn["content"] == "My summary note"

    # Study gamification stats
    stats = db.log_study_activity(add_pomodoro=1, add_quiz=2, add_xp=30)
    assert stats["total_xp"] >= 100
    assert stats["level"] >= 1
    assert stats["streak_days"] >= 1


def test_tunnel_token_extraction():
    raw_cmd = "sudo cloudflared service install eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9"
    extracted = TunnelManager.extract_token(raw_cmd)
    assert extracted.startswith("eyJhIjoi")
    assert " " not in extracted


def test_api_endpoints_read_only_and_study_features(tmp_path: Path, monkeypatch):
    vault = tmp_path / "vault"
    nested = vault / "AI_Command_Prompts" / "SubFolder_A"
    nested.mkdir(parents=True)
    note_path = nested / "01_실제파일명_테스트.md"
    original_content = "---\ntitle: Internal Title\ntags: [clinical, prompt]\n---\n# Heading 1\nBody text with keyword **rehabilitation**."
    note_path.write_text(original_content, encoding="utf-8")

    db_file = tmp_path / "api_test.db"
    monkeypatch.setattr(obsibook_app, "VAULT_PATH", vault)
    monkeypatch.setattr(obsibook_app, "DB_PATH", db_file)
    monkeypatch.setattr(obsibook_app, "APP_PASSWORD", "")

    client = TestClient(obsibook_app.app)

    # 1. Health check
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.json()["read_only"] is True

    # 2. Library listing with nested directories
    r_lib = client.get("/api/library")
    assert r_lib.status_code == 200
    data = r_lib.json()
    assert data["stats"]["total_docs"] == 1
    assert "AI_Command_Prompts/SubFolder_A" in data["directories"]
    assert data["documents"][0]["title"] == "01_실제파일명_테스트"

    # 3. Highlight & Study Note endpoints
    r_hl = client.post(
        "/api/highlights",
        json={
            "doc_path": "AI_Command_Prompts/SubFolder_A/01_실제파일명_테스트.md",
            "selected_text": "rehabilitation",
            "title": "01_실제파일명_테스트",
            "folder": "AI_Command_Prompts/SubFolder_A",
            "note": "Core concept",
            "color": "green",
        },
    )
    assert r_hl.status_code == 200
    assert r_hl.json()["highlight"]["selected_text"] == "rehabilitation"

    r_sn = client.post(
        "/api/study-note",
        json={
            "doc_path": "AI_Command_Prompts/SubFolder_A/01_실제파일명_테스트.md",
            "title": "01_실제파일명_테스트",
            "folder": "AI_Command_Prompts/SubFolder_A",
            "content": "Summary of chapter 1",
        },
    )
    assert r_sn.status_code == 200
    assert r_sn.json()["study_note"]["content"] == "Summary of chapter 1"

    # Verify original markdown file in vault was NEVER modified
    assert note_path.read_text(encoding="utf-8") == original_content

    # 4. Preload batch endpoint & Rescan endpoint
    r_pre = client.get("/api/docs/preload?offset=0&limit=20")
    assert r_pre.status_code == 200
    pre_data = r_pre.json()
    assert pre_data["total"] == 1
    assert len(pre_data["docs"]) == 1
    assert pre_data["docs"][0]["path"] == "AI_Command_Prompts/SubFolder_A/01_실제파일명_테스트.md"
    assert "rehabilitation" in pre_data["docs"][0]["content"]

    r_rescan = client.post("/api/library/rescan")
    assert r_rescan.status_code == 200
    assert r_rescan.json()["stats"]["total_docs"] == 1


def test_two_tier_persistent_vault_cache_and_fast_lookup(tmp_path: Path):
    vault = tmp_path / "vault_cache_test"
    folder = vault / "Rehab_Clinical"
    folder.mkdir(parents=True)
    md1 = folder / "01_Note_A.md"
    md2 = folder / "02_Note_B.md"
    img = folder / "diagram.png"
    md1.write_text("# Note A\nLink to [[02_Note_B]] and ![[diagram.png]]", encoding="utf-8")
    md2.write_text("# Note B\nSecond note content", encoding="utf-8")
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    db_file = tmp_path / "persistent_cache.db"
    db = DatabaseManager(db_file)

    # First scanner builds index and persists to SQLite L2 cache
    scanner1 = VaultScanner(vault, db_path=db_file)
    scanner1.warm_up()
    cached_rows = db.load_vault_cache(str(vault.resolve()))
    assert "Rehab_Clinical/01_Note_A.md" in cached_rows
    assert "Rehab_Clinical/02_Note_B.md" in cached_rows

    # Clear in-memory L1 index and verify new scanner loads from SQLite L2 cache without re-parsing
    from modules import vault_scanner as vs_mod
    vs_mod._VAULT_INDEX_MAP.clear()

    scanner2 = VaultScanner(vault, db_path=db_file)
    doc_a = scanner2.get_document("Rehab_Clinical/01_Note_A.md")
    assert doc_a is not None
    assert doc_a["next_doc"]["path"] == "Rehab_Clinical/02_Note_B.md"
    assert "/api/asset?path=Rehab_Clinical/diagram.png" in doc_a["content"]

    resolved_asset = scanner2.find_asset_path("diagram.png")
    assert resolved_asset == img.resolve()


def test_obsidian_latex_symbols_and_asset_etag_caching(tmp_path: Path, monkeypatch):
    vault = tmp_path / "vault_math_img"
    sub = vault / "Clinical_Notes" / "Shoulder"
    assets_dir = vault / "Attachments"
    sub.mkdir(parents=True)
    assets_dir.mkdir(parents=True)

    photo = assets_dir / "rotator_cuff.png"
    photo.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

    note = sub / "01_어깨재활_수식_테스트.md"
    note.write_text(
        "# **조 (\\rightarrow)** 기전 및 $A \\Rightarrow B$ 분석\n"
        "**회전근개(Rotator Cuff)**는 상완골두 안정화(\\rightarrow)에 핵심이다.\n"
        "![[rotator_cuff.png|480]]\n"
        "![표준마크다운이미지](rotator_cuff.png)\n",
        encoding="utf-8",
    )

    db_file = tmp_path / "math_img.db"
    monkeypatch.setattr(obsibook_app, "VAULT_PATH", vault)
    monkeypatch.setattr(obsibook_app, "DB_PATH", db_file)
    monkeypatch.setattr(obsibook_app, "APP_PASSWORD", "")

    client = TestClient(obsibook_app.app)
    r_doc = client.get("/api/doc", params={"path": "Clinical_Notes/Shoulder/01_어깨재활_수식_테스트.md"})
    assert r_doc.status_code == 200
    doc_data = r_doc.json()

    # Heading and subtitle should have \rightarrow and \Rightarrow converted to → and ⇒
    assert "조 (→) 기전 및 A ⇒ B 분석" in doc_data["headings"][0]["text"]
    # Both Obsidian ![[rotator_cuff.png|480]] and standard ![...](rotator_cuff.png) resolve to Attachments/rotator_cuff.png
    assert "![rotator_cuff.png|480](/api/asset?path=Attachments/rotator_cuff.png)" in doc_data["content"]
    assert "![표준마크다운이미지](/api/asset?path=Attachments/rotator_cuff.png)" in doc_data["content"]

    # Asset endpoint returns immutable Cache-Control + ETag and supports 304 Not Modified
    r_asset1 = client.get("/api/asset", params={"path": "Attachments/rotator_cuff.png"})
    assert r_asset1.status_code == 200
    assert "immutable" in r_asset1.headers.get("cache-control", "")
    etag = r_asset1.headers.get("etag")
    assert etag

    r_asset2 = client.get(
        "/api/asset",
        params={"path": "Attachments/rotator_cuff.png"},
        headers={"If-None-Match": etag},
    )
    assert r_asset2.status_code == 304


def test_webp_image_optimization_and_nfd_korean_asset_lookup(tmp_path: Path, monkeypatch):
    import io
    import unicodedata
    from PIL import Image, ImageDraw

    vault = tmp_path / "vault_webp"
    assets_dir = vault / "Images"
    assets_dir.mkdir(parents=True)

    # Create a large (>60KB) noisy/patterned PNG image with an NFD Korean filename
    nfd_name = unicodedata.normalize("NFD", "어깨_해부도_고해상도.png")
    img_path = assets_dir / nfd_name
    im = Image.new("RGB", (1800, 1400), color=(240, 235, 220))
    draw = ImageDraw.Draw(im)
    for y in range(0, 1400, 4):
        draw.line([(0, y), (1800, (y * 7) % 1400)], fill=((y * 13) % 255, (y * 29) % 255, (y * 47) % 255), width=2)
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=0)
    raw_png_bytes = buf.getvalue()
    assert len(raw_png_bytes) > 60000
    img_path.write_bytes(raw_png_bytes)

    note = vault / "01_NFD_이미지_노트.md"
    nfc_name = unicodedata.normalize("NFC", "어깨_해부도_고해상도.png")
    note.write_text(f"# 테스트\n![[{nfc_name}]]\n", encoding="utf-8")

    db_file = tmp_path / "webp_test.db"
    monkeypatch.setattr(obsibook_app, "VAULT_PATH", vault)
    monkeypatch.setattr(obsibook_app, "DB_PATH", db_file)
    monkeypatch.setattr(obsibook_app, "APP_PASSWORD", "")

    client = TestClient(obsibook_app.app)
    # Request using NFC Korean name even though file on disk is NFD
    r_asset = client.get("/api/asset", params={"path": nfc_name})
    assert r_asset.status_code == 200
    assert r_asset.headers["content-type"] == "image/webp"
    assert len(r_asset.content) < len(raw_png_bytes)
    # Original file in vault remains 100% untouched
    assert img_path.read_bytes() == raw_png_bytes

