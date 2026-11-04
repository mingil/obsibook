import os
import re
import glob
import time
import shutil
import threading
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional

from modules.config import BASE_DIR, DATA_DIR, APP_PORT


class TunnelManager:
    """
    Built-in Cloudflare Tunnel & Custom Domain Manager for ObsiBook.
    Supports:
      1. Quick HTTPS Tunnel (*.trycloudflare.com) for instant zero-config remote access
      2. Named Domain Tunnel via Token (CF_TUNNEL_TOKEN)
      3. Automated Named Domain Tunnel + DNS Routing via Cloudflare Login (cert.pem)
    All credentials and configs are stored inside DATA_DIR (/app/data/cloudflare) so they
    persist across Docker container restarts without touching the Obsidian vault.
    """

    def __init__(self):
        self.cf_dir = DATA_DIR / "cloudflare"
        self.cf_dir.mkdir(parents=True, exist_ok=True)
        self.cert_path = self.cf_dir / "cert.pem"
        self.config_yml_path = self.cf_dir / "config.yml"
        self.tunnel_log_path = self.cf_dir / "tunnel.log"
        self.login_log_path = self.cf_dir / "login.log"

        self.process: Optional[subprocess.Popen] = None
        self.login_process: Optional[subprocess.Popen] = None
        self.active_mode: str = "stopped"  # stopped | quick | token | named_domain
        self.custom_domain: str = os.getenv("CF_CUSTOM_DOMAIN", "").strip()
        self.tunnel_name: str = os.getenv("CF_TUNNEL_NAME", "obsibook").strip()
        self.tunnel_token: str = os.getenv("CF_TUNNEL_TOKEN", "").strip()
        self.status_message: str = "대기 중"
        self._lock = threading.Lock()

    def get_cloudflared_bin(self) -> Optional[str]:
        candidates = [
            str(BASE_DIR / "bin" / "cloudflared"),
            "/usr/local/bin/cloudflared",
            "/usr/bin/cloudflared",
            shutil.which("cloudflared") or "",
        ]
        for c in candidates:
            if c and os.path.exists(c) and os.access(c, os.X_OK):
                return c
        return None

    @staticmethod
    def extract_token(raw_input: str) -> str:
        clean = (raw_input or "").strip().strip('"').strip("'")
        m = re.search(r"(eyJ[a-zA-Z0-9_\-+=/]{30,})", clean)
        if m:
            return m.group(1)
        return clean

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def get_quick_url(self) -> str:
        if not self.tunnel_log_path.exists():
            return ""
        try:
            text = self.tunnel_log_path.read_text(encoding="utf-8", errors="ignore")
            matches = re.findall(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", text)
            return matches[-1] if matches else ""
        except Exception:
            return ""

    def get_login_url(self) -> str:
        if not self.login_log_path.exists():
            return ""
        try:
            text = self.login_log_path.read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"https://dash\.cloudflare\.com/argotunnel\?[^\s\"']+", text)
            return m.group(0) if m else ""
        except Exception:
            return ""

    def get_log_tail(self, lines: int = 12) -> str:
        if not self.tunnel_log_path.exists():
            return ""
        try:
            text = self.tunnel_log_path.read_text(encoding="utf-8", errors="ignore")
            return "\n".join(text.splitlines()[-lines:])
        except Exception:
            return ""

    def check_cert_exists(self) -> bool:
        default_cf_cert = Path.home() / ".cloudflared" / "cert.pem"
        if default_cf_cert.exists() and default_cf_cert.stat().st_size > 50:
            shutil.copy2(default_cf_cert, self.cert_path)
        return self.cert_path.exists() and self.cert_path.stat().st_size > 50

    def get_status(self) -> Dict[str, Any]:
        running = self.is_running()
        if not running and self.active_mode != "stopped":
            self.active_mode = "stopped"

        quick_url = self.get_quick_url() if self.active_mode == "quick" else ""
        public_url = ""
        if running:
            if self.active_mode == "quick":
                public_url = quick_url
            elif self.custom_domain:
                public_url = f"https://{self.custom_domain}"

        return {
            "binary_installed": bool(self.get_cloudflared_bin()),
            "running": running,
            "mode": self.active_mode,
            "custom_domain": self.custom_domain,
            "has_token": bool(self.tunnel_token),
            "has_cert": self.check_cert_exists(),
            "quick_url": quick_url,
            "public_url": public_url,
            "login_url": self.get_login_url(),
            "status_message": self.status_message,
            "log_tail": self.get_log_tail(),
        }

    def stop_tunnel(self) -> None:
        with self._lock:
            if self.process is not None:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=3)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass
                self.process = None
            self.active_mode = "stopped"
            self.status_message = "터널이 중지되었습니다."

    def start_quick_tunnel(self) -> Dict[str, Any]:
        bin_path = self.get_cloudflared_bin()
        if not bin_path:
            return {"ok": False, "error": "cloudflared 바이너리를 찾을 수 없습니다."}

        self.stop_tunnel()
        with self._lock:
            log_f = open(self.tunnel_log_path, "w", encoding="utf-8")
            cmd = [
                bin_path,
                "tunnel",
                "--no-autoupdate",
                "--url",
                f"http://127.0.0.1:{APP_PORT}",
            ]
            self.process = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT)
            self.active_mode = "quick"
            self.status_message = "임시 HTTPS 외부 접속 주소를 생성 중입니다..."

        # Wait up to 6 seconds for trycloudflare URL to appear
        for _ in range(12):
            url = self.get_quick_url()
            if url:
                self.status_message = f"임시 외부 접속 활성화 완료: {url}"
                break
            time.sleep(0.5)

        return {"ok": True, **self.get_status()}

    def start_token_tunnel(self, raw_token: str, custom_domain: str = "") -> Dict[str, Any]:
        bin_path = self.get_cloudflared_bin()
        if not bin_path:
            return {"ok": False, "error": "cloudflared 바이너리를 찾을 수 없습니다."}

        token = self.extract_token(raw_token)
        if not token:
            return {"ok": False, "error": "유효한 Cloudflare 터널 토큰을 입력해 주세요."}

        if custom_domain.strip():
            self.custom_domain = custom_domain.strip().replace("https://", "").replace("http://", "").rstrip("/")
        self.tunnel_token = token

        self.stop_tunnel()
        cmd = [
            bin_path,
            "tunnel",
            "--no-autoupdate",
            "run",
            "--token",
            token,
        ]

        # Try decoding token to auto-generate local config.yml so 503 never happens even without Zero Trust ingress
        try:
            import base64
            import json
            padded = token + "=" * ((4 - len(token) % 4) % 4)
            decoded = json.loads(base64.b64decode(padded).decode("utf-8"))
            if all(k in decoded for k in ("a", "s", "t")):
                tunnel_id = decoded["t"]
                cred_file = self.cf_dir / f"{tunnel_id}.json"
                cred_file.write_text(
                    json.dumps(
                        {
                            "AccountTag": decoded["a"],
                            "TunnelSecret": decoded["s"],
                            "TunnelID": tunnel_id,
                            "Endpoint": "",
                        }
                    ),
                    encoding="utf-8",
                )
                if self.custom_domain and self.check_cert_exists():
                    subprocess.run(
                        [
                            bin_path,
                            "tunnel",
                            "--origincert",
                            str(self.cert_path),
                            "route",
                            "dns",
                            "--overwrite-dns",
                            tunnel_id,
                            self.custom_domain,
                        ],
                        capture_output=True,
                        text=True,
                    )
                ingress_lines = (
                    f"  - hostname: {self.custom_domain}\n    service: http://127.0.0.1:{APP_PORT}\n"
                    if self.custom_domain
                    else ""
                )
                config_yml = (
                    f"tunnel: {tunnel_id}\n"
                    f"credentials-file: {cred_file}\n\n"
                    f"ingress:\n"
                    f"{ingress_lines}"
                    f"  - service: http://127.0.0.1:{APP_PORT}\n"
                )
                self.config_yml_path.write_text(config_yml, encoding="utf-8")
                cmd = [
                    bin_path,
                    "tunnel",
                    "--no-autoupdate",
                    "--config",
                    str(self.config_yml_path),
                    "run",
                    tunnel_id,
                ]
        except Exception:
            pass

        with self._lock:
            log_f = open(self.tunnel_log_path, "w", encoding="utf-8")
            self.process = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT)
            self.active_mode = "token"
            domain_label = f"https://{self.custom_domain}" if self.custom_domain else "Cloudflare Zero Trust"
            self.status_message = f"✅ 토큰 기반 도메인 터널 실행 중 ({domain_label})"

        time.sleep(1.0)
        return {"ok": True, **self.get_status()}

    def start_cloudflare_login_flow(self, desired_domain: str = "") -> Dict[str, Any]:
        """
        Starts `cloudflared tunnel login` to generate a browser clickable OAuth URL
        and watches in a background thread for cert.pem to automatically configure
        the custom domain (e.g. obsibook.yourdomain.com).
        """
        bin_path = self.get_cloudflared_bin()
        if not bin_path:
            return {"ok": False, "error": "cloudflared 바이너리를 찾을 수 없습니다."}

        if desired_domain.strip():
            self.custom_domain = desired_domain.strip().replace("https://", "").replace("http://", "").rstrip("/")

        # If cert.pem is already present, immediately provision and run the domain!
        if self.check_cert_exists():
            return self.provision_and_start_named_domain(self.custom_domain)

        # If a login process is already running and has a valid login_url, keep it alive and just update custom_domain!
        if (
            self.login_process is not None
            and self.login_process.poll() is None
            and self.get_login_url()
        ):
            self.status_message = f"Cloudflare 승인 대기 중 ({self.custom_domain})... 아래 링크를 눌러 도메인을 승인해 주세요."
            return {"ok": True, **self.get_status()}

        default_cf_dir = Path.home() / ".cloudflared"
        default_cf_dir.mkdir(parents=True, exist_ok=True)
        log_f = open(self.login_log_path, "w", encoding="utf-8")
        self.login_process = subprocess.Popen(
            [bin_path, "tunnel", "login"],
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
        self.status_message = "Cloudflare 인증 링크 생성 중... 아래 링크를 눌러 도메인을 승인해 주세요."

        for _ in range(12):
            if self.get_login_url():
                break
            time.sleep(0.5)

        # Start background watcher to detect when cert.pem lands
        threading.Thread(target=self._watch_login_completion, daemon=True).start()
        return {"ok": True, **self.get_status()}

    def _watch_login_completion(self) -> None:
        for _ in range(300):  # Watch for up to 5 minutes
            if self.check_cert_exists():
                self.provision_and_start_named_domain(self.custom_domain)
                return
            time.sleep(1.0)

    def save_uploaded_cert(self, cert_content: str, desired_domain: str = "") -> Dict[str, Any]:
        if "BEGIN" not in cert_content:
            return {"ok": False, "error": "올바른 Cloudflare cert.pem 파일 내용이 아닙니다."}
        if desired_domain.strip():
            self.custom_domain = desired_domain.strip().replace("https://", "").replace("http://", "").rstrip("/")
        self.cert_path.write_text(cert_content, encoding="utf-8")
        default_cf_dir = Path.home() / ".cloudflared"
        default_cf_dir.mkdir(parents=True, exist_ok=True)
        (default_cf_dir / "cert.pem").write_text(cert_content, encoding="utf-8")
        return self.provision_and_start_named_domain(self.custom_domain)

    def provision_and_start_named_domain(self, domain: str) -> Dict[str, Any]:
        import base64
        import json

        bin_path = self.get_cloudflared_bin()
        if not bin_path:
            return {"ok": False, "error": "cloudflared 바이너리를 찾을 수 없습니다."}
        if not self.check_cert_exists():
            return {"ok": False, "error": "Cloudflare 인증서(cert.pem)가 아직 준비되지 않았습니다."}

        clean_domain = domain.strip().replace("https://", "").replace("http://", "").rstrip("/")
        if not clean_domain:
            return {"ok": False, "error": "연결할 도메인 주소(예: obsibook.yourdomain.com)를 입력해 주세요."}
        self.custom_domain = clean_domain

        tunnel_name = self.tunnel_name or "obsibook"
        env = {**os.environ, "TUNNEL_ORIGIN_CERT": str(self.cert_path)}
        cred_path = self.cf_dir / f"{tunnel_name}.json"

        # 1. Query Cloudflare for existing tunnel with this name (NEVER delete an existing tunnel!)
        list_res = subprocess.run(
            [bin_path, "tunnel", "--origincert", str(self.cert_path), "list"],
            capture_output=True,
            text=True,
            env=env,
        )
        m_remote = re.search(
            rf"([0-9a-fA-F]{{8}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{12}})\s+{re.escape(tunnel_name)}\b",
            list_res.stdout or "",
        )
        remote_tunnel_id = m_remote.group(1) if m_remote else None

        local_tunnel_id = None
        if cred_path.exists():
            try:
                local_data = json.loads(cred_path.read_text(encoding="utf-8"))
                local_tunnel_id = local_data.get("TunnelID")
            except Exception:
                local_tunnel_id = None

        if remote_tunnel_id:
            # Tunnel already exists on Cloudflare -> keep its permanent UUID!
            # If local obsibook.json is missing or has a stale/mismatched UUID (e.g. 2e29ec35...),
            # replace obsibook.json by fetching the existing tunnel's token credentials from Cloudflare.
            if not cred_path.exists() or local_tunnel_id != remote_tunnel_id:
                cred_path.unlink(missing_ok=True)
                subprocess.run(
                    [
                        bin_path,
                        "tunnel",
                        "--origincert",
                        str(self.cert_path),
                        "token",
                        "--cred-file",
                        str(cred_path),
                        remote_tunnel_id,
                    ],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                # Fallback: if --cred-file did not write, decode stdout token directly
                if not cred_path.exists():
                    tok_res = subprocess.run(
                        [bin_path, "tunnel", "--origincert", str(self.cert_path), "token", remote_tunnel_id],
                        capture_output=True,
                        text=True,
                        env=env,
                    )
                    raw_tok = self.extract_token(tok_res.stdout or "")
                    if raw_tok:
                        padded = raw_tok + "=" * ((4 - len(raw_tok) % 4) % 4)
                        decoded = json.loads(base64.b64decode(padded).decode("utf-8"))
                        cred_path.write_text(
                            json.dumps(
                                {
                                    "AccountTag": decoded.get("a", ""),
                                    "TunnelSecret": decoded.get("s", ""),
                                    "TunnelID": decoded.get("t", remote_tunnel_id),
                                    "Endpoint": "",
                                }
                            ),
                            encoding="utf-8",
                        )
        else:
            # Tunnel does not exist on Cloudflare yet -> create it once
            cred_path.unlink(missing_ok=True)
            subprocess.run(
                [
                    bin_path,
                    "tunnel",
                    "--origincert",
                    str(self.cert_path),
                    "--cred-file",
                    str(cred_path),
                    "create",
                    tunnel_name,
                ],
                capture_output=True,
                text=True,
                env=env,
            )

        # Find credentials JSON
        if cred_path.exists():
            cred_file = cred_path
        else:
            cred_files = list(self.cf_dir.glob("*.json")) + list((Path.home() / ".cloudflared").glob("*.json"))
            if not cred_files:
                return {"ok": False, "error": "터널 자격증명(.json) 동기화에 실패했습니다."}
            cred_file = max(cred_files, key=lambda p: p.stat().st_mtime)
            if cred_file.parent != self.cf_dir:
                target_cred = self.cf_dir / cred_file.name
                shutil.copy2(cred_file, target_cred)
                cred_file = target_cred

        try:
            cred_data = json.loads(cred_file.read_text(encoding="utf-8"))
            tunnel_id = cred_data.get("TunnelID") or remote_tunnel_id or cred_file.stem
        except Exception:
            tunnel_id = remote_tunnel_id or cred_file.stem

        # 2. Route DNS CNAME record automatically to the permanent tunnel_id
        subprocess.run(
            [
                bin_path,
                "tunnel",
                "--origincert",
                str(self.cert_path),
                "route",
                "dns",
                "--overwrite-dns",
                tunnel_id,
                clean_domain,
            ],
            capture_output=True,
            text=True,
            env=env,
        )

        # 3. Write config.yml
        config_yml = (
            f"tunnel: {tunnel_id}\n"
            f"credentials-file: {cred_file}\n\n"
            f"ingress:\n"
            f"  - hostname: {clean_domain}\n"
            f"    service: http://127.0.0.1:{APP_PORT}\n"
            f"  - service: http_status:404\n"
        )
        self.config_yml_path.write_text(config_yml, encoding="utf-8")

        # 4. Run Named Tunnel
        self.stop_tunnel()
        with self._lock:
            log_f = open(self.tunnel_log_path, "w", encoding="utf-8")
            cmd = [
                bin_path,
                "tunnel",
                "--no-autoupdate",
                "--origincert",
                str(self.cert_path),
                "--config",
                str(self.config_yml_path),
                "run",
                tunnel_id,
            ]
            self.process = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT, env=env)
            self.active_mode = "named_domain"
            self.status_message = f"✅ https://{clean_domain} 도메인 자동 개통 및 연결 완료! (고정 터널 ID: {tunnel_id[:8]}...)"

        time.sleep(1.0)
        return {"ok": True, **self.get_status()}


# Singleton instance
tunnel_manager = TunnelManager()
