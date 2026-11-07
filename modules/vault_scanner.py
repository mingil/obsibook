import os
import io
import re
import time
import hashlib
import mimetypes
import threading
import unicodedata
import yaml
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from urllib.parse import quote, unquote
from modules.config import (
    VAULT_PATH,
    DATA_DIR,
    DB_PATH,
    IGNORED_DIRS,
    ALLOWED_IMAGE_EXTENSIONS,
    SUPPORTED_DOC_EXTENSIONS,
)
from modules.db_manager import DatabaseManager

try:
    from PIL import Image, ImageOps
    _HAS_PILLOW = True
except Exception:
    _HAS_PILLOW = False

ASSET_CACHE_DIR = DATA_DIR / "asset_cache"
ASSET_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_ASSET_RAM_CACHE: Dict[str, Tuple[bytes, str, str]] = {}
_ASSET_RAM_LOCK = threading.Lock()
_MAX_RAM_CACHE_ITEMS = 400
_RASTER_OPTIMIZE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}


def _norm_key(text: str) -> str:
    return unicodedata.normalize("NFC", str(text or "")).strip().lower()


def get_optimized_asset_payload(
    asset_path: Path, raw: bool = False
) -> Tuple[Optional[bytes], str, str]:
    """
    Returns (bytes_or_none, media_type, etag) for a vault asset.
    - 100% Read-Only on the vault: never modifies asset_path!
    - Compresses large PNG/JPG/BMP images (>48KB) into crisp, lightweight WebP
      cached in both RAM (_ASSET_RAM_CACHE) and disk (DATA_DIR/asset_cache).
    - Caches small images (<=48KB) directly in RAM so serving takes 0ms (zero HDD I/O).
    """
    ext = asset_path.suffix.lower()
    guessed_mime, _ = mimetypes.guess_type(str(asset_path))
    orig_mime = guessed_mime or "application/octet-stream"

    try:
        st = asset_path.stat()
        mtime_ns = st.st_mtime_ns
        size_bytes = st.st_size
    except Exception:
        return None, orig_mime, ""

    if raw or ext not in _RASTER_OPTIMIZE_EXTS:
        etag = f'W/"raw-{mtime_ns:x}-{size_bytes:x}"'
        return None, orig_mime, etag

    key_seed = f"{asset_path}|{mtime_ns}|{size_bytes}|v2"
    cache_key = hashlib.sha1(key_seed.encode("utf-8")).hexdigest()[:24]
    etag = f'W/"opt-{cache_key}"'

    # 1. Instant 0ms L1 RAM Cache Hit
    with _ASSET_RAM_LOCK:
        ram_hit = _ASSET_RAM_CACHE.get(cache_key)
        if ram_hit is not None:
            return ram_hit

    # 2. L2 Persistent Disk Cache Hit (DATA_DIR/asset_cache)
    disk_cache_file = ASSET_CACHE_DIR / f"{cache_key}.webp"
    if disk_cache_file.is_file():
        try:
            webp_bytes = disk_cache_file.read_bytes()
            if webp_bytes:
                payload = (webp_bytes, "image/webp", etag)
                with _ASSET_RAM_LOCK:
                    if len(_ASSET_RAM_CACHE) >= _MAX_RAM_CACHE_ITEMS:
                        _ASSET_RAM_CACHE.pop(next(iter(_ASSET_RAM_CACHE)), None)
                    _ASSET_RAM_CACHE[cache_key] = payload
                return payload
        except Exception:
            pass

    # 3. Read original file once from disk
    try:
        raw_bytes = asset_path.read_bytes()
    except Exception:
        return None, orig_mime, etag

    # Small files (<= 48KB) or environments without Pillow: cache directly in RAM!
    if size_bytes <= 49152 or not _HAS_PILLOW:
        payload = (raw_bytes, orig_mime, etag)
        with _ASSET_RAM_LOCK:
            if len(_ASSET_RAM_CACHE) >= _MAX_RAM_CACHE_ITEMS:
                _ASSET_RAM_CACHE.pop(next(iter(_ASSET_RAM_CACHE)), None)
            _ASSET_RAM_CACHE[cache_key] = payload
        return payload

    # 4. Optimize larger raster images (> 48KB) into fast WebP (max 1440px, quality=82)
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            img = ImageOps.exif_transpose(img)
            max_dim = 1440
            if img.width > max_dim or img.height > max_dim:
                img.thumbnail((max_dim, max_dim), Image.Resampling.BILINEAR)

            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if "A" in img.mode else "RGB")

            out_buf = io.BytesIO()
            img.save(out_buf, format="WEBP", quality=82, method=1)
            webp_bytes = out_buf.getvalue()

            if webp_bytes and len(webp_bytes) < len(raw_bytes):
                try:
                    disk_cache_file.write_bytes(webp_bytes)
                except Exception:
                    pass
                payload = (webp_bytes, "image/webp", etag)
                with _ASSET_RAM_LOCK:
                    if len(_ASSET_RAM_CACHE) >= _MAX_RAM_CACHE_ITEMS:
                        _ASSET_RAM_CACHE.pop(next(iter(_ASSET_RAM_CACHE)), None)
                    _ASSET_RAM_CACHE[cache_key] = payload
                return payload
    except Exception:
        pass

    # Fallback: cache original bytes in RAM if image is tiny/unusual or WebP wasn't smaller
    payload = (raw_bytes, orig_mime, etag)
    with _ASSET_RAM_LOCK:
        if len(_ASSET_RAM_CACHE) >= _MAX_RAM_CACHE_ITEMS:
            _ASSET_RAM_CACHE.pop(next(iter(_ASSET_RAM_CACHE)), None)
        _ASSET_RAM_CACHE[cache_key] = payload
    return payload


_PREWARM_IN_PROGRESS = False
_PREWARM_LOCK = threading.Lock()


def _prewarm_assets_async(asset_paths: List[Path]) -> None:
    global _PREWARM_IN_PROGRESS
    with _PREWARM_LOCK:
        if _PREWARM_IN_PROGRESS:
            return
        _PREWARM_IN_PROGRESS = True

    def _worker():
        global _PREWARM_IN_PROGRESS
        try:
            for p in asset_paths:
                if p.suffix.lower() in _RASTER_OPTIMIZE_EXTS:
                    get_optimized_asset_payload(p, raw=False)
        except Exception:
            pass
        finally:
            with _PREWARM_LOCK:
                _PREWARM_IN_PROGRESS = False

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


FRONTMATTER_RE = re.compile(r"\A---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|\Z)", re.DOTALL)
HEADING_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$", re.MULTILINE)
INLINE_TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z0-9가-힣_\-/]{2,40})")
WIKILINK_EMBED_RE = re.compile(r"!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")
WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]")
MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\n]+)\)")
HIGHLIGHT_SYNTAX_RE = re.compile(r"==([^=\n]+)==")
LATEX_MACRO_RE = re.compile(r"\\([a-zA-Z]+)(?![a-zA-Z])")

LATEX_SYMBOL_MAP: Dict[str, str] = {
    "rightarrow": "→",
    "to": "→",
    "Rightarrow": "⇒",
    "implies": "⇒",
    "leftarrow": "←",
    "gets": "←",
    "Leftarrow": "⇐",
    "leftrightarrow": "↔",
    "Leftrightarrow": "⇔",
    "iff": "⇔",
    "uparrow": "↑",
    "Uparrow": "⇑",
    "downarrow": "↓",
    "Downarrow": "⇓",
    "mapsto": "↦",
    "longmapsto": "⟼",
    "longrightarrow": "⟶",
    "Longrightarrow": "⟹",
    "longleftarrow": "⟵",
    "Longleftarrow": "⟸",
    "longleftrightarrow": "⟷",
    "Longleftrightarrow": "⟺",
    "nearrow": "↗",
    "searrow": "↘",
    "swarrow": "↙",
    "nwarrow": "↖",
    "times": "×",
    "div": "÷",
    "pm": "±",
    "mp": "∓",
    "cdot": "·",
    "bullet": "•",
    "ast": "∗",
    "star": "⋆",
    "circ": "∘",
    "degree": "°",
    "leq": "≤",
    "le": "≤",
    "geq": "≥",
    "ge": "≥",
    "neq": "≠",
    "ne": "≠",
    "approx": "≈",
    "sim": "∼",
    "simeq": "≃",
    "cong": "≅",
    "equiv": "≡",
    "propto": "∝",
    "infty": "∞",
    "therefore": "∴",
    "because": "∵",
    "forall": "∀",
    "exists": "∃",
    "nexists": "∄",
    "in": "∈",
    "notin": "∉",
    "ni": "∋",
    "subset": "⊂",
    "subseteq": "⊆",
    "supset": "⊃",
    "supseteq": "⊇",
    "cup": "∪",
    "cap": "∩",
    "emptyset": "∅",
    "varnothing": "∅",
    "nabla": "∇",
    "partial": "∂",
    "perp": "⊥",
    "parallel": "∥",
    "angle": "∠",
    "triangle": "△",
    "alpha": "α",
    "beta": "β",
    "gamma": "γ",
    "delta": "δ",
    "epsilon": "ε",
    "varepsilon": "ε",
    "zeta": "ζ",
    "eta": "η",
    "theta": "θ",
    "vartheta": "ϑ",
    "iota": "ι",
    "kappa": "κ",
    "lambda": "λ",
    "mu": "μ",
    "nu": "ν",
    "xi": "ξ",
    "pi": "π",
    "rho": "ρ",
    "sigma": "σ",
    "tau": "τ",
    "upsilon": "υ",
    "phi": "φ",
    "varphi": "ϕ",
    "chi": "χ",
    "psi": "ψ",
    "omega": "ω",
    "Gamma": "Γ",
    "Delta": "Δ",
    "Theta": "Θ",
    "Lambda": "Λ",
    "Xi": "Ξ",
    "Pi": "Π",
    "Sigma": "Σ",
    "Upsilon": "Υ",
    "Phi": "Φ",
    "Psi": "Ψ",
    "Omega": "Ω",
}


def replace_latex_symbols(text: str) -> str:
    if not text or "\\" not in text:
        return text
    return LATEX_MACRO_RE.sub(
        lambda m: LATEX_SYMBOL_MAP.get(m.group(1), m.group(0)), text
    )


def clean_obsidian_inline_text(text: str) -> str:
    if not text:
        return ""
    cleaned = replace_latex_symbols(text)
    cleaned = re.sub(r"\$\$([^$]+)\$\$", r"\1", cleaned)
    cleaned = re.sub(r"\$([^$\n]+)\$", r"\1", cleaned)
    cleaned = re.sub(r"(\*\*|__|~~|==|`)", "", cleaned)
    return cleaned.strip()


# Use C-accelerated YAML loader when available
_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


def natural_sort_key(text: str) -> List[Any]:
    """
    Natural sort key so '1_Note', '2_Note', '10_Note' sort in human order (1, 2, 10).
    """
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", str(text or ""))
    ]


def slugify_heading(text: str) -> str:
    clean = re.sub(r"<[^>]+>", "", str(text or ""))
    clean = clean_obsidian_inline_text(clean)
    clean = re.sub(r"[`*~_\[\](){}!@#$%^&+=|\\:;\"'<>,.?/]", "", clean).strip().lower()
    clean = re.sub(r"\s+", "-", clean)
    return clean or "section"


class _VaultMemoryIndex:
    """
    In-memory L1 index for a single vault directory, backed by SQLite L2 cache (vault_doc_cache).
    Ensures O(1) document lookups, O(1) asset resolution, and zero-disk-read incremental syncs.
    """

    def __init__(self, vault_path: Path):
        self.vault_path = vault_path
        self.lock = threading.RLock()
        self.loaded_from_db: bool = False
        self.assets_prewarmed: bool = False
        self.last_scan_mono: float = 0.0
        self.last_scan_ms: float = 0.0

        # rel_path -> { mtime_ns, size_bytes, meta, raw_body, resolved_body, search_text }
        self.records: Dict[str, Dict[str, Any]] = {}
        self.sorted_docs: List[Dict[str, Any]] = []
        self.doc_idx_map: Dict[str, int] = {}
        self.folder_docs_map: Dict[str, List[Dict[str, Any]]] = {}
        self.stem_to_path: Dict[str, str] = {}
        self.path_lookup: Dict[str, str] = {}
        self.dir_paths: List[str] = []
        self.asset_by_rel: Dict[str, Path] = {}
        self.asset_by_name: Dict[str, Path] = {}
        self.asset_rel_lookup: Dict[str, str] = {}
        self.asset_rel_by_name: Dict[str, str] = {}


_VAULT_INDEX_MAP: Dict[str, _VaultMemoryIndex] = {}
_VAULT_INDEX_GLOBAL_LOCK = threading.Lock()


def _get_vault_memory_index(vault_path: Path) -> _VaultMemoryIndex:
    key = str(vault_path.resolve())
    with _VAULT_INDEX_GLOBAL_LOCK:
        idx = _VAULT_INDEX_MAP.get(key)
        if idx is None:
            idx = _VaultMemoryIndex(vault_path.resolve())
            _VAULT_INDEX_MAP[key] = idx
        return idx


class VaultScanner:
    """
    100% Read-Only Obsidian Vault Scanner & Hierarchical Folder Explorer
    with Two-Tier Persistent Indexing (RAM L1 + SQLite L2 Cache).
    Never writes to or modifies any file inside the vault directory.
    Preserves exact user filenames and exact nested folder hierarchies.
    """

    def __init__(self, vault_path: Path = VAULT_PATH, db_path: Path = DB_PATH):
        self.vault_path = Path(vault_path).resolve()
        self.db_path = Path(db_path).resolve()

    def is_safe_subpath(self, target: Path) -> bool:
        try:
            resolved = target.resolve()
            return resolved == self.vault_path or self.vault_path in resolved.parents
        except Exception:
            return False

    def _should_ignore(self, name: str) -> bool:
        if not name:
            return True
        if name in IGNORED_DIRS:
            return True
        if name.startswith(".") and name not in {".", ".."}:
            return True
        return False

    @staticmethod
    def parse_frontmatter(raw_text: str) -> Tuple[Dict[str, Any], str]:
        if not raw_text.startswith("---"):
            return {}, raw_text
        match = FRONTMATTER_RE.match(raw_text)
        if not match:
            return {}, raw_text
        fm_raw = match.group(1)
        body = raw_text[match.end():]
        try:
            parsed = yaml.load(fm_raw, Loader=_YAML_LOADER)
            if isinstance(parsed, dict):
                normalized = {}
                for k, v in parsed.items():
                    if hasattr(v, "isoformat"):
                        normalized[str(k)] = v.isoformat()
                    else:
                        normalized[str(k)] = v
                return normalized, body
        except Exception:
            pass
        return {}, body

    @staticmethod
    def extract_headings(body: str) -> List[Dict[str, Any]]:
        headings: List[Dict[str, Any]] = []
        in_code_block = False
        seen_slugs: Dict[str, int] = {}

        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_code_block = not in_code_block
                continue
            if in_code_block:
                continue

            if not stripped.startswith("#"):
                continue

            m = re.match(r"^(#{1,4})\s+(.+?)\s*$", stripped)
            if m:
                level = len(m.group(1))
                raw_title = m.group(2).strip()
                clean_title = re.sub(r"<[^>]+>", "", raw_title).strip()
                # Clean markdown links/wikilinks in headings so TOC matches rendered DOM text
                clean_title = WIKILINK_RE.sub(
                    lambda wm: (wm.group(3) or wm.group(1)).strip(), clean_title
                )
                clean_title = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", clean_title)
                clean_title = clean_obsidian_inline_text(clean_title)
                base_slug = slugify_heading(clean_title)
                count = seen_slugs.get(base_slug, 0)
                seen_slugs[base_slug] = count + 1
                slug = f"{base_slug}-{count}" if count > 0 else base_slug
                headings.append(
                    {
                        "level": level,
                        "text": clean_title,
                        "id": slug,
                    }
                )
        return headings

    @staticmethod
    def extract_tags(frontmatter: Dict[str, Any], body: str) -> List[str]:
        tags = set()
        fm_tags = frontmatter.get("tags") or frontmatter.get("tag")
        if isinstance(fm_tags, list):
            for t in fm_tags:
                if t:
                    tags.add(str(t).lstrip("#").strip())
        elif isinstance(fm_tags, str):
            for t in re.split(r"[,\s]+", fm_tags):
                if t.strip():
                    tags.add(t.strip().lstrip("#"))

        body_no_code = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
        for m in INLINE_TAG_RE.finditer(body_no_code):
            candidate = m.group(1).strip()
            if re.fullmatch(r"[0-9a-fA-F]{3}|[0-9a-fA-F]{6}", candidate):
                continue
            tags.add(candidate)

        return sorted(tags)

    @staticmethod
    def build_breadcrumbs(folder_rel_path: str) -> List[Dict[str, str]]:
        if not folder_rel_path:
            return []
        parts = [p for p in folder_rel_path.split("/") if p]
        crumbs = []
        acc = []
        for p in parts:
            acc.append(p)
            crumbs.append({"name": p, "path": "/".join(acc)})
        return crumbs

    def _parse_single_file(
        self,
        full_path: Path,
        rel_path: str,
        fname: str,
        ext: str,
        mtime_ns: int,
        size_bytes: int,
        mtime_str: str,
    ) -> Optional[Dict[str, Any]]:
        parts = rel_path.split("/")
        top_folder = parts[0] if len(parts) > 1 else "Root"
        sub_folder = "/".join(parts[:-1]) if len(parts) > 1 else ""
        parent_folder_name = parts[-2] if len(parts) > 1 else "Root"
        exact_stem = full_path.stem

        if ext == ".pdf":
            meta = {
                "path": rel_path,
                "filename": fname,
                "stem": exact_stem,
                "title": exact_stem,
                "subtitle": "PDF 문서",
                "frontmatter_title": "",
                "doc_type": "pdf",
                "top_folder": top_folder,
                "folder": sub_folder,
                "folder_name": parent_folder_name,
                "folder_depth": len(parts) - 1,
                "breadcrumbs": self.build_breadcrumbs(sub_folder),
                "tags": ["PDF"],
                "date": mtime_str[:10],
                "mtime": mtime_str,
                "size_bytes": size_bytes,
                "char_count": 0,
                "reading_time_min": 5,
                "heading_count": 0,
                "headings": [],
                "excerpt": f"PDF 문서 ({round(size_bytes / 1024, 1)} KB)",
                "frontmatter": {},
            }
            return {
                "doc_path": rel_path,
                "mtime_ns": mtime_ns,
                "size_bytes": size_bytes,
                "meta": meta,
                "raw_body": "",
                "resolved_body": "",
                "search_text": f"{exact_stem.lower()} {sub_folder.lower()} pdf",
            }

        try:
            raw_text = full_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None

        frontmatter, body = self.parse_frontmatter(raw_text)
        headings = self.extract_headings(body)
        tags = self.extract_tags(frontmatter, body)

        fm_title = str(frontmatter.get("title", "")).strip()
        first_heading = ""
        for h in headings:
            if h["level"] in (1, 2):
                first_heading = h["text"]
                break

        subtitle = clean_obsidian_inline_text(fm_title or first_heading)
        if subtitle == exact_stem:
            subtitle = ""

        # Compute char count & excerpt efficiently
        preview_source = body[:4000]
        plain_preview = re.sub(r"<[^>]+>", "", preview_source)
        plain_preview = clean_obsidian_inline_text(plain_preview)
        plain_preview = re.sub(r"[#*>`~\-\[\]()!|$]", " ", plain_preview)
        plain_preview = re.sub(r"\s+", " ", plain_preview).strip()

        # Estimate total char count accurately without running heavy regex on multi-MB strings
        if len(body) <= 4000:
            char_count = len(plain_preview)
        else:
            ratio = len(plain_preview) / max(1, len(preview_source))
            char_count = max(len(plain_preview), int(len(body) * ratio))

        reading_time_min = max(1, round(char_count / 650))

        meta = {
            "path": rel_path,
            "filename": fname,
            "stem": exact_stem,
            "title": exact_stem,
            "subtitle": subtitle,
            "frontmatter_title": fm_title,
            "doc_type": "markdown",
            "top_folder": top_folder,
            "folder": sub_folder,
            "folder_name": parent_folder_name,
            "folder_depth": len(parts) - 1,
            "breadcrumbs": self.build_breadcrumbs(sub_folder),
            "tags": tags,
            "date": str(frontmatter.get("date", mtime_str[:10])),
            "mtime": mtime_str,
            "size_bytes": size_bytes,
            "char_count": char_count,
            "reading_time_min": reading_time_min,
            "heading_count": len(headings),
            "headings": headings,
            "excerpt": plain_preview[:220] + ("..." if len(plain_preview) > 220 else ""),
            "frontmatter": frontmatter,
        }

        return {
            "doc_path": rel_path,
            "mtime_ns": mtime_ns,
            "size_bytes": size_bytes,
            "meta": meta,
            "raw_body": body,
            "resolved_body": None,
            "search_text": body.lower(),
        }

    @staticmethod
    def _resolve_asset_rel_path(
        raw_target: str,
        asset_rel_lookup: Optional[Dict[str, str]] = None,
        asset_rel_by_name: Optional[Dict[str, str]] = None,
        doc_folder: str = "",
    ) -> str:
        clean_target = unquote(raw_target.strip()).lstrip("/").replace("\\", "/")
        while clean_target.startswith("./") or clean_target.startswith("../"):
            clean_target = re.sub(r"^(?:\./|\.\./)+", "", clean_target)
        if not asset_rel_lookup and not asset_rel_by_name:
            return clean_target

        lookup = asset_rel_lookup or {}
        by_name = asset_rel_by_name or {}

        if doc_folder:
            scoped = _norm_key(f"{doc_folder.strip('/')}/{clean_target}")
            if scoped in lookup:
                return lookup[scoped]

        low = _norm_key(clean_target)
        if low in lookup:
            return lookup[low]

        fname_low = _norm_key(Path(clean_target).name)
        if fname_low in by_name:
            return by_name[fname_low]

        return clean_target

    @staticmethod
    def _resolve_wikilinks_with_maps(
        body: str,
        stem_to_path: Dict[str, str],
        path_lookup: Dict[str, str],
        asset_rel_lookup: Optional[Dict[str, str]] = None,
        asset_rel_by_name: Optional[Dict[str, str]] = None,
        doc_folder: str = "",
    ) -> str:
        if not body:
            return ""

        def replace_embed(match: re.Match) -> str:
            target = match.group(1).strip()
            pipe_part = (match.group(2) or "").strip()
            alt = f"{target}|{pipe_part}" if pipe_part else target
            ext = Path(target).suffix.lower()
            resolved_asset = VaultScanner._resolve_asset_rel_path(
                target, asset_rel_lookup, asset_rel_by_name, doc_folder
            )
            if ext == ".pdf":
                return f'\n<div class="embedded-pdf-box my-4"><iframe src="/api/asset?path={quote(resolved_asset)}" class="w-full h-[600px] rounded-xl border"></iframe></div>\n'
            if ext in ALLOWED_IMAGE_EXTENSIONS:
                return f"![{alt}](/api/asset?path={quote(resolved_asset)})"
            return f"📎 *[{pipe_part or target}](#wikilink:{target})*"

        if "![[" in body:
            body = WIKILINK_EMBED_RE.sub(replace_embed, body)

        def replace_md_image(match: re.Match) -> str:
            alt = match.group(1)
            raw_url = match.group(2).strip()
            if (
                raw_url.startswith("http://")
                or raw_url.startswith("https://")
                or raw_url.startswith("/api/asset")
                or raw_url.startswith("data:")
            ):
                return match.group(0)
            url_target = raw_url.split(" ")[0].strip("\"'")
            ext = Path(unquote(url_target)).suffix.lower()
            if ext in ALLOWED_IMAGE_EXTENSIONS:
                resolved_asset = VaultScanner._resolve_asset_rel_path(
                    url_target, asset_rel_lookup, asset_rel_by_name, doc_folder
                )
                return f"![{alt}](/api/asset?path={quote(resolved_asset)})"
            return match.group(0)

        if "![" in body:
            body = MD_IMAGE_RE.sub(replace_md_image, body)

        def replace_wikilink(match: re.Match) -> str:
            target_doc = match.group(1).strip()
            heading_part = (match.group(2) or "").strip()
            label = (match.group(3) or target_doc).strip()

            key = target_doc.lower()
            resolved = path_lookup.get(key) or stem_to_path.get(Path(target_doc).stem.lower())
            if resolved:
                anchor = f"#{slugify_heading(heading_part)}" if heading_part else ""
                return f"[{label}](#doc:{quote(resolved)}{anchor})"
            return f"[{label}](#unresolved:{quote(target_doc)})"

        if "[[" in body:
            body = WIKILINK_RE.sub(replace_wikilink, body)

        if "==" in body:
            segments = re.split(r"(```.*?```|`[^`\n]+`)", body, flags=re.DOTALL)
            for i in range(0, len(segments), 2):
                segments[i] = HIGHLIGHT_SYNTAX_RE.sub(r'<mark class="obs-hl">\1</mark>', segments[i])
            return "".join(segments)

        return body

    def _resolve_wikilinks(self, body: str, all_docs: List[Dict[str, Any]]) -> str:
        stem_to_path: Dict[str, str] = {}
        path_lookup: Dict[str, str] = {}
        for d in all_docs:
            stem_to_path[d["stem"].lower()] = d["path"]
            path_lookup[d["path"].lower()] = d["path"]
            if d["path"].lower().endswith(".md"):
                path_lookup[d["path"][:-3].lower()] = d["path"]
        return self._resolve_wikilinks_with_maps(body, stem_to_path, path_lookup)

    def sync_index(self, force: bool = False, ttl_sec: float = 0.0) -> _VaultMemoryIndex:
        """
        Synchronizes the in-memory L1 index and SQLite L2 cache with the filesystem.
        Unchanged files (matching mtime_ns and size_bytes) are NEVER re-read or re-parsed!
        """
        idx = _get_vault_memory_index(self.vault_path)
        with idx.lock:
            now_mono = time.monotonic()
            if (
                not force
                and idx.last_scan_mono > 0
                and ttl_sec > 0
                and (now_mono - idx.last_scan_mono) < ttl_sec
            ):
                return idx

            t0 = time.perf_counter()
            vault_root_str = str(self.vault_path)

            # 1. Load persistent L2 cache from SQLite on first run
            db: Optional[DatabaseManager] = None
            if not idx.loaded_from_db:
                try:
                    db = DatabaseManager(self.db_path)
                    persisted = db.load_vault_cache(vault_root_str)
                    for doc_path, rec in persisted.items():
                        rec["resolved_body"] = None
                        meta = rec.get("meta")
                        if isinstance(meta, dict):
                            if meta.get("excerpt"):
                                meta["excerpt"] = clean_obsidian_inline_text(meta["excerpt"])
                            if meta.get("subtitle"):
                                meta["subtitle"] = clean_obsidian_inline_text(meta["subtitle"])
                            if isinstance(meta.get("headings"), list):
                                for h in meta["headings"]:
                                    if isinstance(h, dict) and h.get("text"):
                                        h["text"] = clean_obsidian_inline_text(h["text"])
                                        h["id"] = slugify_heading(h["text"])
                        idx.records[doc_path] = rec
                except Exception:
                    pass
                idx.loaded_from_db = True

            if not self.vault_path.exists():
                idx.records.clear()
                idx.sorted_docs = []
                idx.doc_idx_map = {}
                idx.folder_docs_map = {}
                idx.dir_paths = []
                idx.asset_by_rel = {}
                idx.asset_by_name = {}
                idx.asset_rel_lookup = {}
                idx.asset_rel_by_name = {}
                idx.last_scan_mono = time.monotonic()
                return idx

            # 2. Fast filesystem walk using os.scandir (only stats files, does NOT read unchanged files)
            discovered_dirs: List[str] = []
            asset_by_rel: Dict[str, Path] = {}
            asset_by_name: Dict[str, Path] = {}
            asset_rel_lookup: Dict[str, str] = {}
            asset_rel_by_name: Dict[str, str] = {}
            seen_doc_paths: set = set()
            upserts: List[Dict[str, Any]] = []
            structure_changed = False

            def _scan_dir_recursive(current_dir: Path, rel_prefix: str) -> None:
                nonlocal structure_changed
                try:
                    with os.scandir(current_dir) as it:
                        entries = list(it)
                except Exception:
                    return

                for entry in entries:
                    name = entry.name
                    if self._should_ignore(name):
                        continue

                    rel_item = f"{rel_prefix}/{name}" if rel_prefix else name
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            discovered_dirs.append(rel_item)
                            _scan_dir_recursive(Path(entry.path), rel_item)
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(name)[1].lower()
                            full_p = Path(entry.path)
                            if ext in ALLOWED_IMAGE_EXTENSIONS:
                                rel_low = _norm_key(rel_item)
                                name_low = _norm_key(name)
                                asset_by_rel[rel_low] = full_p
                                asset_by_path_raw_low = rel_item.lower()
                                asset_by_rel[asset_by_path_raw_low] = full_p
                                asset_by_name.setdefault(name_low, full_p)
                                asset_by_name.setdefault(name.lower(), full_p)
                                asset_rel_lookup[rel_low] = rel_item
                                asset_rel_lookup[asset_by_path_raw_low] = rel_item
                                asset_rel_by_name.setdefault(name_low, rel_item)
                                asset_rel_by_name.setdefault(name.lower(), rel_item)

                            if ext in SUPPORTED_DOC_EXTENSIONS:
                                st = entry.stat(follow_symlinks=False)
                                mtime_ns = st.st_mtime_ns
                                size_bytes = st.st_size
                                seen_doc_paths.add(rel_item)

                                cached_rec = idx.records.get(rel_item)
                                if (
                                    cached_rec is not None
                                    and cached_rec["mtime_ns"] == mtime_ns
                                    and cached_rec["size_bytes"] == size_bytes
                                ):
                                    continue

                                mtime_str = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
                                parsed = self._parse_single_file(
                                    full_path=full_p,
                                    rel_path=rel_item,
                                    fname=name,
                                    ext=ext,
                                    mtime_ns=mtime_ns,
                                    size_bytes=size_bytes,
                                    mtime_str=mtime_str,
                                )
                                if parsed is not None:
                                    idx.records[rel_item] = parsed
                                    upserts.append(parsed)
                                    structure_changed = True
                    except Exception:
                        continue

            _scan_dir_recursive(self.vault_path, "")

            # 3. Detect deleted documents
            deleted_paths = [p for p in list(idx.records.keys()) if p not in seen_doc_paths]
            for dp in deleted_paths:
                idx.records.pop(dp, None)
                structure_changed = True

            if len(discovered_dirs) != len(idx.dir_paths) or set(discovered_dirs) != set(idx.dir_paths):
                structure_changed = True

            idx.dir_paths = sorted(discovered_dirs, key=natural_sort_key)
            idx.asset_by_rel = asset_by_rel
            idx.asset_by_name = asset_by_name
            idx.asset_rel_lookup = asset_rel_lookup
            idx.asset_rel_by_name = asset_rel_by_name

            # 4. Rebuild sorted lookup tables & pre-resolve wikilinks if anything changed or first load
            if structure_changed or not idx.sorted_docs and idx.records:
                all_meta = [r["meta"] for r in idx.records.values()]
                all_meta.sort(key=lambda d: (natural_sort_key(d["folder"]), natural_sort_key(d["stem"])))
                idx.sorted_docs = all_meta
                idx.doc_idx_map = {d["path"]: i for i, d in enumerate(all_meta)}

                stem_to_path: Dict[str, str] = {}
                path_lookup: Dict[str, str] = {}
                folder_docs_map: Dict[str, List[Dict[str, Any]]] = {}

                for d in all_meta:
                    stem_to_path[d["stem"].lower()] = d["path"]
                    path_lookup[d["path"].lower()] = d["path"]
                    if d["path"].lower().endswith(".md"):
                        path_lookup[d["path"][:-3].lower()] = d["path"]

                    f_key = d["folder"]
                    folder_docs_map.setdefault(f_key, []).append(
                        {
                            "path": d["path"],
                            "title": d["title"],
                            "subtitle": d.get("subtitle", ""),
                            "doc_type": d.get("doc_type", "markdown"),
                            "reading_time_min": d["reading_time_min"],
                        }
                    )

                idx.stem_to_path = stem_to_path
                idx.path_lookup = path_lookup
                idx.folder_docs_map = folder_docs_map

                # Pre-resolve wikilinks, images & highlights in memory so get_document() is instant (< 0.1ms)
                for rec in idx.records.values():
                    if rec["resolved_body"] is None or structure_changed:
                        if rec["meta"].get("doc_type") == "pdf":
                            rec["resolved_body"] = ""
                        else:
                            rec["resolved_body"] = self._resolve_wikilinks_with_maps(
                                rec["raw_body"],
                                stem_to_path,
                                path_lookup,
                                asset_rel_lookup,
                                asset_rel_by_name,
                                rec["meta"].get("folder", ""),
                            )

            # 5. Persist any new/updated/deleted records to SQLite L2 cache
            if upserts or deleted_paths:
                try:
                    if db is None:
                        db = DatabaseManager(self.db_path)
                    db.save_vault_cache_batch(vault_root_str, upserts, deleted_paths)
                except Exception:
                    pass

            # 6. Pre-compress & pre-warm raster images into RAM/WebP cache in background
            #    처음 한 번 + 볼트 구조가 바뀌었을 때만 실행. (예전에는 매 스캔마다 실행되어,
            #    RAM 캐시(400개)보다 이미지가 많으면 30초마다 디스크 캐시 전체를 다시 읽었음)
            if asset_by_rel and (structure_changed or not idx.assets_prewarmed):
                _prewarm_assets_async(list(set(asset_by_rel.values())))
                idx.assets_prewarmed = True

            idx.last_scan_mono = time.monotonic()
            idx.last_scan_ms = round((time.perf_counter() - t0) * 1000, 2)
            return idx

    def warm_up(self) -> Dict[str, Any]:
        idx = self.sync_index(force=True)
        return {
            "total_docs": len(idx.sorted_docs),
            "total_dirs": len(idx.dir_paths),
            "scan_ms": idx.last_scan_ms,
        }

    def scan_all_documents(self, use_ttl: bool = False) -> List[Dict[str, Any]]:
        idx = self.sync_index(force=False, ttl_sec=5.0 if use_ttl else 0.0)
        return [dict(d) for d in idx.sorted_docs]

    def build_vault_tree(
        self,
        progress_map: Optional[Dict[str, Dict[str, Any]]] = None,
        force_rescan: bool = False,
        use_ttl: bool = False,
    ) -> Dict[str, Any]:
        progress_map = progress_map or {}
        idx = self.sync_index(
            force=force_rescan,
            ttl_sec=0.0 if force_rescan else (5.0 if use_ttl else 0.0),
        )
        docs = [dict(d) for d in idx.sorted_docs]

        # 1. Discover ALL physical directories recursively so nested folder hierarchy is 100% preserved
        dir_nodes: Dict[str, Dict[str, Any]] = {}

        def ensure_dir_node(rel_dir: str) -> Dict[str, Any]:
            rel_dir = rel_dir.strip("/")
            if rel_dir in dir_nodes:
                return dir_nodes[rel_dir]

            parts = [p for p in rel_dir.split("/") if p]
            name = parts[-1] if parts else "Root"
            parent_path = "/".join(parts[:-1]) if len(parts) > 1 else ""
            top_folder = parts[0] if parts else "Root"

            if parent_path and parent_path not in dir_nodes:
                ensure_dir_node(parent_path)

            node = {
                "path": rel_dir,
                "name": name,
                "parent_path": parent_path,
                "top_folder": top_folder,
                "depth": max(0, len(parts) - 1),
                "breadcrumbs": self.build_breadcrumbs(rel_dir),
                "subfolder_paths": [],
                "subfolders": [],
                "direct_docs": [],
                "docs": [],
                "direct_doc_count": 0,
                "total_doc_count": 0,
                "doc_count": 0,
                "subfolder_count": 0,
                "completed_count": 0,
                "in_progress_count": 0,
            }
            dir_nodes[rel_dir] = node
            if parent_path and rel_dir not in dir_nodes[parent_path]["subfolder_paths"]:
                dir_nodes[parent_path]["subfolder_paths"].append(rel_dir)
            return node

        for rel_dir in idx.dir_paths:
            ensure_dir_node(rel_dir)

        all_tags_counter: Dict[str, int] = {}
        root_direct_docs: List[Dict[str, Any]] = []

        # 2. Attach documents to their exact parent directory AND update ancestor stats
        for doc in docs:
            p_info = progress_map.get(doc["path"])
            doc["scroll_percent"] = p_info["scroll_percent"] if p_info else 0.0
            doc["is_completed"] = bool(p_info["is_completed"]) if p_info else False
            doc["last_read_at"] = p_info["last_read_at"] if p_info else ""
            doc["heading_text"] = p_info["heading_text"] if p_info else ""

            folder_path = doc["folder"]
            if not folder_path:
                root_direct_docs.append(doc)
            else:
                node = ensure_dir_node(folder_path)
                node["direct_docs"].append(doc)
                node["direct_doc_count"] += 1

                # Propagate counts up to all ancestor folders (without duplicating heavy doc objects!)
                parts = folder_path.split("/")
                for i in range(1, len(parts) + 1):
                    anc_path = "/".join(parts[:i])
                    anc_node = ensure_dir_node(anc_path)
                    anc_node["total_doc_count"] += 1
                    anc_node["doc_count"] = anc_node["total_doc_count"]
                    if doc["is_completed"]:
                        anc_node["completed_count"] += 1
                    elif doc["scroll_percent"] > 0:
                        anc_node["in_progress_count"] += 1

            for t in doc["tags"]:
                all_tags_counter[t] = all_tags_counter.get(t, 0) + 1

        # 3. Wire subfolder summaries in natural order
        for rel_dir, node in dir_nodes.items():
            node["subfolder_paths"].sort(key=natural_sort_key)
            node["direct_docs"].sort(key=lambda d: natural_sort_key(d["stem"]))
            node["subfolder_count"] = len(node["subfolder_paths"])
            node["subfolders"] = [
                {
                    "path": sp,
                    "name": dir_nodes[sp]["name"],
                    "parent_path": dir_nodes[sp]["parent_path"],
                    "depth": dir_nodes[sp]["depth"],
                    "direct_doc_count": dir_nodes[sp]["direct_doc_count"],
                    "total_doc_count": dir_nodes[sp]["total_doc_count"],
                    "subfolder_count": len(dir_nodes[sp]["subfolder_paths"]),
                    "completed_count": dir_nodes[sp]["completed_count"],
                    "in_progress_count": dir_nodes[sp]["in_progress_count"],
                }
                for sp in node["subfolder_paths"]
            ]

        # Build recursive nested tree for sidebar explorer (lightweight direct_docs)
        def build_recursive_tree(rel_dir: str) -> Dict[str, Any]:
            n = dir_nodes[rel_dir]
            return {
                "path": n["path"],
                "name": n["name"],
                "parent_path": n["parent_path"],
                "depth": n["depth"],
                "direct_doc_count": n["direct_doc_count"],
                "total_doc_count": n["total_doc_count"],
                "subfolder_count": n["subfolder_count"],
                "completed_count": n["completed_count"],
                "in_progress_count": n["in_progress_count"],
                "direct_docs": [
                    {
                        "path": d["path"],
                        "title": d["title"],
                        "doc_type": d.get("doc_type", "markdown"),
                        "scroll_percent": d.get("scroll_percent", 0.0),
                        "is_completed": d.get("is_completed", False),
                        "reading_time_min": d.get("reading_time_min", 1),
                    }
                    for d in n["direct_docs"]
                ],
                "children": [build_recursive_tree(sp) for sp in n["subfolder_paths"]],
            }

        top_level_paths = sorted(
            [p for p, n in dir_nodes.items() if n["parent_path"] == ""],
            key=natural_sort_key,
        )
        folder_tree = [build_recursive_tree(tp) for tp in top_level_paths]
        top_folders_list = [dir_nodes[tp] for tp in top_level_paths]

        if root_direct_docs:
            root_pseudo = {
                "path": "Root",
                "name": "Root (최상위 문서)",
                "parent_path": "",
                "top_folder": "Root",
                "depth": 0,
                "breadcrumbs": [{"name": "Root", "path": "Root"}],
                "subfolder_paths": [],
                "subfolders": [],
                "direct_docs": root_direct_docs,
                "docs": [],
                "direct_doc_count": len(root_direct_docs),
                "total_doc_count": len(root_direct_docs),
                "doc_count": len(root_direct_docs),
                "subfolder_count": 0,
                "completed_count": sum(1 for d in root_direct_docs if d.get("is_completed")),
                "in_progress_count": sum(
                    1 for d in root_direct_docs if not d.get("is_completed") and d.get("scroll_percent", 0) > 0
                ),
            }
            dir_nodes["Root"] = root_pseudo
            top_folders_list.append(root_pseudo)
            folder_tree.append(
                {
                    **root_pseudo,
                    "children": [],
                }
            )

        tags_list = [
            {"tag": k, "count": v}
            for k, v in sorted(all_tags_counter.items(), key=lambda x: (-x[1], x[0].lower()))
        ]

        return {
            "vault_path": str(self.vault_path),
            "total_docs": len(docs),
            "scan_ms": idx.last_scan_ms,
            "folders": top_folders_list,
            "folder_tree": folder_tree,
            "directories": dir_nodes,
            "documents": docs,
            "tags": tags_list,
        }

    def get_document(self, rel_path: str) -> Optional[Dict[str, Any]]:
        clean_rel = rel_path.lstrip("/").replace("\\", "/")
        if not clean_rel or ".." in clean_rel.split("/"):
            return None

        idx = _get_vault_memory_index(self.vault_path)
        rec = idx.records.get(clean_rel)

        # Ultra-fast 0-syscall RAM hit when index was synced within the last 15 seconds
        if rec is not None and idx.last_scan_mono > 0 and (time.monotonic() - idx.last_scan_mono) < 15.0:
            pass
        else:
            full_path = (self.vault_path / clean_rel).resolve()
            if not self.is_safe_subpath(full_path) or not full_path.is_file():
                return None
            try:
                st = full_path.stat()
            except Exception:
                return None

            if (
                idx.last_scan_mono == 0
                or rec is None
                or rec["mtime_ns"] != st.st_mtime_ns
                or rec["size_bytes"] != st.st_size
            ):
                idx = self.sync_index(force=True)
                rec = idx.records.get(clean_rel)

        if rec is None:
            return None

        current_meta = rec["meta"]
        all_docs = idx.sorted_docs
        doc_pos = idx.doc_idx_map.get(clean_rel, -1)

        prev_doc = None
        next_doc = None
        if doc_pos > 0:
            p_item = all_docs[doc_pos - 1]
            prev_doc = {
                "path": p_item["path"],
                "title": p_item["title"],
                "folder": p_item["folder"] or p_item["top_folder"],
            }
        if 0 <= doc_pos < len(all_docs) - 1:
            n_item = all_docs[doc_pos + 1]
            next_doc = {
                "path": n_item["path"],
                "title": n_item["title"],
                "folder": n_item["folder"] or n_item["top_folder"],
            }

        cur_folder = current_meta["folder"]
        sibling_docs = idx.folder_docs_map.get(cur_folder, [])
        prev_in_folder = None
        next_in_folder = None
        for s_idx, sd in enumerate(sibling_docs):
            if sd["path"] == clean_rel:
                if s_idx > 0:
                    prev_in_folder = {
                        "path": sibling_docs[s_idx - 1]["path"],
                        "title": sibling_docs[s_idx - 1]["title"],
                        "folder": cur_folder or "Root",
                    }
                if s_idx + 1 < len(sibling_docs):
                    next_in_folder = {
                        "path": sibling_docs[s_idx + 1]["path"],
                        "title": sibling_docs[s_idx + 1]["title"],
                        "folder": cur_folder or "Root",
                    }
                break

        if current_meta.get("doc_type") == "pdf":
            return {
                "path": clean_rel,
                "filename": current_meta["filename"],
                "stem": current_meta["stem"],
                "title": current_meta["title"],
                "subtitle": "PDF 문서",
                "frontmatter_title": "",
                "doc_type": "pdf",
                "asset_url": f"/api/asset?path={quote(clean_rel)}",
                "top_folder": current_meta["top_folder"],
                "folder": cur_folder,
                "folder_name": current_meta["folder_name"],
                "breadcrumbs": current_meta["breadcrumbs"],
                "sibling_docs": sibling_docs,
                "date": current_meta["date"],
                "mtime": current_meta["mtime"],
                "char_count": 0,
                "reading_time_min": 5,
                "frontmatter": {},
                "tags": ["PDF"],
                "headings": [],
                "content": "",
                "prev_doc": prev_in_folder or prev_doc,
                "next_doc": next_in_folder or next_doc,
                "prev_global_doc": prev_doc,
                "next_global_doc": next_doc,
            }

        resolved_body = rec.get("resolved_body")
        if resolved_body is None:
            resolved_body = self._resolve_wikilinks_with_maps(
                rec["raw_body"],
                idx.stem_to_path,
                idx.path_lookup,
                idx.asset_rel_lookup,
                idx.asset_rel_by_name,
                cur_folder,
            )
            rec["resolved_body"] = resolved_body

        return {
            "path": clean_rel,
            "filename": current_meta["filename"],
            "stem": current_meta["stem"],
            "title": current_meta["title"],
            "subtitle": current_meta.get("subtitle", ""),
            "frontmatter_title": current_meta.get("frontmatter_title", ""),
            "doc_type": "markdown",
            "top_folder": current_meta["top_folder"],
            "folder": cur_folder,
            "folder_name": current_meta["folder_name"],
            "breadcrumbs": current_meta["breadcrumbs"],
            "sibling_docs": sibling_docs,
            "date": current_meta["date"],
            "mtime": current_meta["mtime"],
            "char_count": current_meta["char_count"],
            "reading_time_min": current_meta["reading_time_min"],
            "frontmatter": current_meta["frontmatter"],
            "tags": current_meta["tags"],
            "headings": current_meta.get("headings", []),
            "content": resolved_body,
            "prev_doc": prev_in_folder or prev_doc,
            "next_doc": next_in_folder or next_doc,
            "prev_global_doc": prev_doc,
            "next_global_doc": next_doc,
        }

    def get_documents_batch(self, offset: int = 0, limit: int = 40) -> Dict[str, Any]:
        """
        Returns a batch of pre-resolved markdown documents from the in-memory index
        so the browser client can pre-cache the entire vault in IndexedDB/RAM for 0ms opening.
        """
        idx = self.sync_index(force=False, ttl_sec=30.0)
        all_docs = idx.sorted_docs
        total = len(all_docs)
        sliced = all_docs[offset : offset + limit]
        items = []
        for meta in sliced:
            doc_obj = self.get_document(meta["path"])
            if doc_obj:
                items.append(doc_obj)
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": (offset + limit) < total,
            "docs": items,
        }

    def find_asset_path(self, rel_or_name: str) -> Optional[Path]:
        clean = unquote(rel_or_name).lstrip("/").replace("\\", "/")
        while clean.startswith("./") or clean.startswith("../"):
            clean = re.sub(r"^(?:\./|\.\./)+", "", clean)
        clean_low = _norm_key(clean)
        target_name = _norm_key(Path(clean).name)

        # 1. Instant 0ms O(1) RAM lookup from pre-built memory index (NEVER blocks on directory scan!)
        idx = _get_vault_memory_index(self.vault_path)
        if idx.last_scan_mono > 0:
            by_rel = idx.asset_by_rel.get(clean_low) or idx.asset_by_rel.get(clean.lower())
            if by_rel is not None:
                return by_rel
            by_name = idx.asset_by_name.get(target_name) or idx.asset_by_name.get(Path(clean).name.lower())
            if by_name is not None:
                return by_name

        # 2. Direct path check on disk
        direct = (self.vault_path / clean).resolve()
        if self.is_safe_subpath(direct) and direct.is_file():
            if direct.suffix.lower() in ALLOWED_IMAGE_EXTENSIONS:
                return direct

        # 3. Fallback: populate or refresh index if asset wasn't found yet
        idx = self.sync_index(force=False, ttl_sec=60.0)
        by_rel = idx.asset_by_rel.get(clean_low) or idx.asset_by_rel.get(clean.lower())
        if by_rel and self.is_safe_subpath(by_rel) and by_rel.is_file():
            return by_rel

        by_name = idx.asset_by_name.get(target_name) or idx.asset_by_name.get(Path(clean).name.lower())
        if by_name and self.is_safe_subpath(by_name) and by_name.is_file():
            return by_name

        return None

    def search(self, query: str, folder: str = "", tag: str = "") -> List[Dict[str, Any]]:
        """
        Instant full-text search using the in-memory index (ZERO disk reads!).
        """
        q = query.strip().lower()
        idx = self.sync_index(force=False, ttl_sec=5.0)
        results: List[Dict[str, Any]] = []

        f_low = folder.lower().strip("/") if folder else ""
        t_low = tag.lower().strip() if tag else ""

        for doc in idx.sorted_docs:
            if f_low:
                doc_f_low = doc["folder"].lower()
                if doc_f_low != f_low and not doc_f_low.startswith(f_low + "/") and doc["top_folder"].lower() != f_low:
                    continue
            if t_low and t_low not in [t.lower() for t in doc["tags"]]:
                continue

            if not q:
                results.append({**doc, "match_snippet": doc["excerpt"], "score": 1})
                continue

            if doc.get("doc_type") == "pdf":
                if q in doc["title"].lower() or q in doc["folder"].lower():
                    results.append({**doc, "match_snippet": doc["excerpt"], "score": 10, "occurrences": 1})
                continue

            rec = idx.records.get(doc["path"])
            if not rec:
                continue

            body = rec["raw_body"]
            body_lower = rec["search_text"]
            title_lower = doc["title"].lower()
            subtitle_lower = doc.get("subtitle", "").lower()
            folder_lower = doc["folder"].lower()
            tags_joined = " ".join(doc["tags"]).lower()

            score = 0
            if q in title_lower:
                score += 15
            if q in subtitle_lower:
                score += 8
            if q in folder_lower:
                score += 5
            if q in tags_joined:
                score += 6
            body_occurrences = body_lower.count(q)
            if body_occurrences > 0:
                score += min(20, body_occurrences * 2)

            if score > 0:
                pos = body_lower.find(q)
                if pos != -1:
                    start = max(0, pos - 70)
                    end = min(len(body), pos + len(q) + 110)
                    snippet = re.sub(r"\s+", " ", body[start:end]).strip()
                    if start > 0:
                        snippet = "..." + snippet
                    if end < len(body):
                        snippet = snippet + "..."
                else:
                    snippet = doc["excerpt"]

                results.append(
                    {
                        **doc,
                        "match_snippet": snippet,
                        "score": score,
                        "occurrences": body_occurrences,
                    }
                )

        results.sort(key=lambda r: (-r["score"], natural_sort_key(r["path"])))
        return results
