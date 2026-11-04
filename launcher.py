import json
import os
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from urllib.parse import urlsplit

from version import __version__


APP_NAME = "BitSeekWin"
APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / APP_NAME / "slskd"
PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_DOWNLOAD_DIR = PROJECT_DIR / "downloads"
SLSKD_URL = "http://127.0.0.1:5030"
PORT = 8080


def normalize_public_url(value: str) -> str:
    url = value.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("Enter a full public URL, such as https://device.tailnet.ts.net.")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("Enter only the base URL; do not include credentials, a path, or query.")
    return url


def build_slskd_environment(
    base: dict[str, str],
    username: str,
    password: str,
    api_key: str,
    downloads_dir: Path,
    app_dir: Path = APP_DIR,
) -> dict[str, str]:
    env = base.copy()
    env.pop("SLSKD_CONFIG", None)
    env.update(
        {
            "APP_DIR": str(app_dir),
            "SLSKD_SLSK_USERNAME": username,
            "SLSKD_SLSK_PASSWORD": password,
            "SLSKD_DOWNLOADS_DIR": str(downloads_dir),
            "SLSKD_API_KEY": f"role=ReadWrite;{api_key}",
            "SLSKD_HTTP_IP_ADDRESS": "127.0.0.1",
            "SLSKD_HTTP_PORT": "5030",
        }
    )
    return env


def build_bitseekwin_environment(
    base: dict[str, str],
    api_key: str,
    downloads_dir: Path,
    public_url: str,
) -> dict[str, str]:
    env = base.copy()
    env.update(
        {
            "SLSKD_URL": SLSKD_URL,
            "SLSKD_API_KEY": api_key,
            "SLSKD_DOWNLOAD_DIR": str(downloads_dir),
            "PUBLIC_BASE_URL": public_url,
        }
    )
    return env


def find_tailscale() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tailscale" / "tailscale.exe",
        Path(r"C:\Program Files (x86)\Tailscale IPN\tailscale.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def detect_tailscale_url(tailscale: str | None = None) -> str:
    executable = tailscale or find_tailscale()
    if not executable:
        return ""
    try:
        result = subprocess.run(
            [executable, "status", "--json"],
            capture_output=True,
            check=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        dns_name = json.loads(result.stdout).get("Self", {}).get("DNSName", "").rstrip(".")
        return f"https://{dns_name}" if dns_name else ""
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return ""


def _terminate_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=8)
    except OSError:
        return
    except subprocess.TimeoutExpired:
        try:
            process.kill()
            process.wait(timeout=5)
        except OSError:
            return


class BitSeekWinLauncher:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(f"BitSeekWin Launcher v{__version__}")
        self.root.geometry("760x690")
        self.root.minsize(680, 620)
        self.messages: queue.Queue[tuple[str, str]] = queue.Queue()
        self.slskd_process: subprocess.Popen | None = None
        self.server_process: subprocess.Popen | None = None
        self.starting = False
        self.tailscale = find_tailscale()

        self.slskd_path = tk.StringVar()
        self.username = tk.StringVar()
        self.password = tk.StringVar()
        self.downloads_dir = tk.StringVar(value=str(DEFAULT_DOWNLOAD_DIR))
        self.public_url = tk.StringVar(value=detect_tailscale_url(self.tailscale) or "http://127.0.0.1:8080")
        self.start_funnel = tk.BooleanVar(value=self.public_url.get().endswith(".ts.net"))
        self.status = tk.StringVar(value="Enter your slskd location and Soulseek login to get started.")

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(150, self._drain_messages)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=16)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(1, weight=1)

        ttk.Label(outer, text=f"BitSeekWin v{__version__}", font=("Segoe UI", 20, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w"
        )
        ttk.Label(
            outer,
            text="Start slskd and the BitChord add-on from one window.",
        ).grid(row=1, column=0, columnspan=3, sticky="w", pady=(2, 14))

        self._path_row(outer, 2, "slskd.exe", self.slskd_path, self._browse_slskd)
        self._entry_row(outer, 3, "Soulseek username", self.username)
        self._entry_row(outer, 4, "Soulseek password", self.password, show="*")
        self._path_row(outer, 5, "Downloads folder", self.downloads_dir, self._browse_downloads)
        self._entry_row(outer, 6, "Public URL", self.public_url)

        self.funnel_check = ttk.Checkbutton(
            outer,
            text="Start Tailscale Funnel on port 8080 (only if you use a .ts.net URL)",
            variable=self.start_funnel,
        )
        self.funnel_check.grid(row=7, column=0, columnspan=3, sticky="w", pady=(8, 4))

        ttk.Label(
            outer,
            text=(
                "Credentials are used only for this launch and are not saved by BitSeekWin. "
                "They remain in process memory while running. slskd's existing YAML values can "
                "override environment settings; this launcher uses a separate BitSeekWin slskd data folder."
            ),
            wraplength=700,
            justify="left",
        ).grid(row=8, column=0, columnspan=3, sticky="w", pady=(2, 10))

        buttons = ttk.Frame(outer)
        buttons.grid(row=9, column=0, columnspan=3, sticky="w", pady=(0, 10))
        self.start_button = ttk.Button(buttons, text="Start", command=self.start)
        self.start_button.pack(side="left")
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))
        ttk.Label(buttons, textvariable=self.status).pack(side="left", padx=(14, 0))

        ttk.Label(outer, text="Status and add-on URL").grid(
            row=10, column=0, columnspan=3, sticky="w"
        )
        self.output = tk.Text(outer, height=12, wrap="word", state="disabled")
        self.output.grid(row=11, column=0, columnspan=3, sticky="nsew", pady=(4, 0))
        outer.rowconfigure(11, weight=1)

    @staticmethod
    def _entry_row(
        parent: ttk.Frame,
        row: int,
        label: str,
        variable: tk.StringVar,
        show: str | None = None,
    ) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=4)
        entry = ttk.Entry(parent, textvariable=variable, show=show)
        entry.grid(row=row, column=1, columnspan=2, sticky="ew", padx=(10, 0), pady=4)

    @staticmethod
    def _path_row(
        parent: ttk.Frame,
        row: int,
        label: str,
        variable: tk.StringVar,
        browse,
    ) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=4)
        ttk.Entry(parent, textvariable=variable).grid(
            row=row, column=1, sticky="ew", padx=(10, 6), pady=4
        )
        ttk.Button(parent, text="Browse…", command=browse).grid(
            row=row, column=2, sticky="ew", pady=4
        )

    def _browse_slskd(self) -> None:
        selected = filedialog.askopenfilename(
            title="Select slskd.exe",
            filetypes=(("slskd executable", "slskd.exe"), ("Executables", "*.exe"), ("All files", "*.*")),
        )
        if selected:
            self.slskd_path.set(selected)

    def _browse_downloads(self) -> None:
        selected = filedialog.askdirectory(title="Select slskd downloads folder")
        if selected:
            self.downloads_dir.set(selected)

    def _append(self, text: str) -> None:
        self.output.configure(state="normal")
        self.output.insert("end", text.rstrip() + "\n")
        self.output.see("end")
        self.output.configure(state="disabled")

    def _read_output(self, name: str, process: subprocess.Popen) -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            self.messages.put(("log", f"[{name}] {line.rstrip()}"))

    def _start_worker(
        self,
        executable: Path,
        username: str,
        password: str,
        downloads: Path,
        public_url: str,
        start_funnel: bool,
    ) -> None:
        try:
            downloads.mkdir(parents=True, exist_ok=True)
            APP_DIR.mkdir(parents=True, exist_ok=True)
            api_key = secrets.token_urlsafe(32)
            base_env = os.environ.copy()
            slskd_env = build_slskd_environment(base_env, username, password, api_key, downloads)

            for port, service in ((5030, "slskd"), (PORT, "BitSeekWin")):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                        raise RuntimeError(f"Port {port} is already in use; close the existing {service} first.")
                except OSError:
                    pass

            if start_funnel:
                if not self.tailscale:
                    raise RuntimeError("Tailscale was not found. Install it or uncheck the Funnel option.")
                result = subprocess.run(
                    [self.tailscale, "funnel", "--bg", str(PORT)],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if result.returncode:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Tailscale Funnel failed.")
                self.messages.put(("log", "Tailscale Funnel configured for port 8080."))

            self.slskd_process = subprocess.Popen(
                [str(executable)],
                cwd=str(executable.parent),
                env=slskd_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            threading.Thread(
                target=self._read_output,
                args=("slskd", self.slskd_process),
                daemon=True,
            ).start()
            self.messages.put(("log", "Starting slskd…"))

            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if self.slskd_process.poll() is not None:
                    raise RuntimeError(
                        f"slskd exited with code {self.slskd_process.returncode}. Check its status output."
                    )
                try:
                    with socket.create_connection(("127.0.0.1", 5030), timeout=0.5):
                        break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("slskd did not open port 5030 within 60 seconds.")

            server_env = build_bitseekwin_environment(base_env, api_key, downloads, public_url)
            self.server_process = subprocess.Popen(
                [sys.executable, str(PROJECT_DIR / "server.py")],
                cwd=str(PROJECT_DIR),
                env=server_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            threading.Thread(
                target=self._read_output,
                args=("BitSeekWin", self.server_process),
                daemon=True,
            ).start()
            self.messages.put(("started", "Both services started. Keep this window open while testing."))
        except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as exc:
            self.messages.put(("error", str(exc)))
            _terminate_process(self.server_process)
            _terminate_process(self.slskd_process)
            self.server_process = None
            self.slskd_process = None

    def start(self) -> None:
        if self.starting or self._any_process_running():
            return
        executable = Path(self.slskd_path.get().strip())
        downloads = Path(self.downloads_dir.get().strip())
        username = self.username.get().strip()
        password = self.password.get()
        try:
            public_url = normalize_public_url(self.public_url.get())
        except ValueError as exc:
            messagebox.showerror("Check the public URL", str(exc))
            return
        if self.start_funnel.get() and not public_url.startswith("https://"):
            messagebox.showerror("HTTPS required", "Use an https:// URL when starting Tailscale Funnel.")
            return
        if not executable.is_file():
            messagebox.showerror("slskd.exe not found", "Browse to the slskd.exe file.")
            return
        if not username or not password:
            messagebox.showerror("Soulseek login required", "Enter your Soulseek username and password.")
            return
        if not downloads.is_absolute():
            messagebox.showerror("Invalid downloads folder", "Choose an absolute folder path.")
            return
        self.starting = True
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="disabled")
        self.status.set("Starting…")
        self._append("Starting services. Secrets are not written to a settings file.")
        threading.Thread(
            target=self._start_worker,
            args=(executable, username, password, downloads, public_url, self.start_funnel.get()),
            daemon=True,
        ).start()

    def _any_process_running(self) -> bool:
        return any(
            process is not None and process.poll() is None
            for process in (self.slskd_process, self.server_process)
        )

    def stop(self) -> None:
        self.status.set("Stopping…")
        _terminate_process(self.server_process)
        _terminate_process(self.slskd_process)
        self.server_process = None
        self.slskd_process = None
        self.starting = False
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        self.status.set("Stopped. Tailscale Funnel, if enabled, remains configured.")
        self._append("Stopped BitSeekWin and slskd. Tailscale Funnel remains configured in Tailscale.")

    def _drain_messages(self) -> None:
        while True:
            try:
                kind, text = self.messages.get_nowait()
            except queue.Empty:
                break
            self._append(text)
            if kind == "started":
                self.starting = False
                self.status.set(text)
                self.stop_button.configure(state="normal")
            elif kind == "error":
                self.starting = False
                self.status.set("Startup failed.")
                self.start_button.configure(state="normal")
                messagebox.showerror("BitSeekWin could not start", text)
                self.stop_button.configure(state="disabled")
        if not self.starting and not self._any_process_running():
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
        elif not self.starting and (
            (self.server_process is not None and self.server_process.poll() is not None)
            or (self.slskd_process is not None and self.slskd_process.poll() is not None)
        ):
            self.status.set("A service stopped. Check the status output, then click Stop before restarting.")
        self.root.after(150, self._drain_messages)

    def _on_close(self) -> None:
        if self.starting:
            messagebox.showinfo("Starting services", "Wait for startup to finish before closing this window.")
            return
        if self._any_process_running():
            if not messagebox.askyesno("Stop services?", "Stop slskd and BitSeekWin before closing?"):
                return
            self.stop()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    BitSeekWinLauncher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
