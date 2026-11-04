import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

# Vault path: defaults to /vault inside Docker if present, otherwise sample_vault
DEFAULT_VAULT = "/vault" if os.path.exists("/vault") else str(BASE_DIR / "sample_vault")
VAULT_PATH = Path(os.getenv("OBSIDIAN_VAULT_PATH", DEFAULT_VAULT)).resolve()

# Persistent data path for SQLite (bookmarks, reading progress, highlights, study stats, settings)
# Completely separated from VAULT_PATH so the Obsidian vault remains 100% untouched (Read-Only)
DEFAULT_DATA = str(BASE_DIR / "data")
DATA_DIR = Path(os.getenv("DATA_DIR", DEFAULT_DATA)).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "obsibook_reader.db"

# Optional App Password for external access protection
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()
APP_SECRET = os.getenv("APP_SECRET", "obsibook-default-secret-key-2026").strip()

# Customizable Library Title
VAULT_TITLE = os.getenv("VAULT_TITLE", "ObsiBook Library").strip()

# Server Port
APP_PORT = int(os.getenv("APP_PORT", "8500"))

# Ignored folders inside an Obsidian vault or Synology NAS
IGNORED_DIRS = {
    ".obsidian",
    ".trash",
    ".git",
    ".github",
    "@eaDir",
    "#recycle",
    ".DS_Store",
    "__pycache__",
    "node_modules",
    ".pytest_cache",
}

ALLOWED_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".pdf", ".mp3", ".wav", ".m4a", ".mp4", ".webm"
}

SUPPORTED_DOC_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".pdf"
}
