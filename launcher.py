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
    COLORS = {
        "background": "#111114",
        "sidebar": "#19191e",
        "surface": "#202026",
        "surface_alt": "#28282f",
        "surface_hover": "#33333c",
        "text": "#f5f4f6",
        "muted": "#aaa8b1",
        "subtle": "#77757f",
        "accent": "#fa315c",
        "accent_dark": "#d91f49",
        "green": "#54d68b",
        "border": "#34343c",
    }

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(f"BitSeekWin v{__version__}")
        self.root.geometry("1100x850")
        self.root.minsize(920, 740)
        self.root.configure(bg=self.COLORS["background"])
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
        self.status_detail = tk.StringVar(value="Ready")
        self.source_url = tk.StringVar(value="")

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(150, self._drain_messages)

    def _build_ui(self) -> None:
        colors = self.COLORS
        shell = tk.Frame(self.root, bg=colors["background"])
        shell.pack(fill="both", expand=True)
        shell.grid_columnconfigure(1, weight=1)
        shell.grid_rowconfigure(0, weight=1)

        sidebar = tk.Frame(shell, bg=colors["sidebar"], width=205)
        sidebar.grid(row=0, column=0, sticky="ns")
        sidebar.grid_propagate(False)
        self._build_sidebar(sidebar)

        main = tk.Frame(shell, bg=colors["background"], padx=28, pady=22)
        main.grid(row=0, column=1, sticky="nsew")
        main.grid_columnconfigure(0, weight=1)
        main.grid_rowconfigure(5, weight=1)

        header = tk.Frame(main, bg=colors["background"])
        header.grid(row=0, column=0, sticky="ew", pady=(0, 17))
        tk.Label(
            header,
            text="YOUR PERSONAL MUSIC BRIDGE",
            font=("Segoe UI", 9, "bold"),
            fg=colors["muted"],
            bg=colors["background"],
        ).pack(side="left")
        self.version_badge = tk.Label(
            header,
            text="VERY EARLY PRE-ALPHA",
            font=("Segoe UI", 8, "bold"),
            fg="#ff9aae",
            bg="#39202a",
            padx=10,
            pady=5,
        )
        self.version_badge.pack(side="right")

        self.hero = tk.Canvas(
            main,
            height=158,
            bg=colors["accent_dark"],
            highlightthickness=0,
            bd=0,
        )
        self.hero.grid(row=1, column=0, sticky="ew", pady=(0, 21))
        self.hero.bind("<Configure>", self._draw_hero)
        self.hero.bind("<Button-1>", lambda _event: None)

        section_header = tk.Frame(main, bg=colors["background"])
        section_header.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        tk.Label(
            section_header,
            text="CONNECT YOUR SOURCES",
            font=("Segoe UI", 9, "bold"),
            fg=colors["muted"],
            bg=colors["background"],
        ).pack(side="left")
        tk.Label(
            section_header,
            text="Your login stays on this device",
            font=("Segoe UI", 9),
            fg=colors["subtle"],
            bg=colors["background"],
        ).pack(side="right")

        cards = tk.Frame(main, bg=colors["background"])
        cards.grid(row=3, column=0, sticky="ew")
        cards.grid_columnconfigure(0, weight=1, uniform="cards")
        cards.grid_columnconfigure(1, weight=1, uniform="cards")
        service_card = self._card(cards)
        service_card.grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        storage_card = self._card(cards)
        storage_card.grid(row=0, column=1, sticky="nsew", padx=(7, 0))
        self._build_service_card(service_card)
        self._build_storage_card(storage_card)

        security_note = tk.Label(
            main,
            text=(
                "Credentials are used for this session only. BitSeekWin does not save them. "
                "slskd data uses a separate app folder; its API listens on this PC only."
            ),
            font=("Segoe UI", 8),
            fg=colors["subtle"],
            bg=colors["background"],
            anchor="w",
            justify="left",
            wraplength=760,
        )
        security_note.grid(row=4, column=0, sticky="ew", pady=(10, 13))

        status_panel = self._card(main, padding=13)
        status_panel.grid(row=5, column=0, sticky="nsew")
        status_panel.grid_columnconfigure(0, weight=1)
        status_top = tk.Frame(status_panel, bg=colors["surface"])
        status_top.grid(row=0, column=0, sticky="ew")
        status_top.grid_columnconfigure(1, weight=1)
        tk.Label(
            status_top,
            text="ACTIVITY",
            font=("Segoe UI", 9, "bold"),
            fg=colors["muted"],
            bg=colors["surface"],
        ).grid(row=0, column=0, sticky="w")
        self.status_dot = tk.Label(
            status_top,
            text="●",
            font=("Segoe UI", 10),
            fg=colors["subtle"],
            bg=colors["surface"],
        )
        self.status_dot.grid(row=0, column=1, sticky="e", padx=(0, 6))
        self.status_label = tk.Label(
            status_top,
            textvariable=self.status_detail,
            font=("Segoe UI", 9, "bold"),
            fg=colors["muted"],
            bg=colors["surface"],
        )
        self.status_label.grid(row=0, column=2, sticky="e")
        self.copy_url_button = self._action_button(
            status_top,
            "Copy source URL",
            self._copy_source_url,
        )
        self.copy_url_button.configure(state="disabled")
        self.copy_url_button.grid(row=0, column=3, sticky="e", padx=(12, 0))

        output_frame = tk.Frame(status_panel, bg=colors["surface"])
        output_frame.grid(row=1, column=0, sticky="nsew", pady=(9, 0))
        status_panel.grid_rowconfigure(1, weight=1)
        output_frame.grid_columnconfigure(0, weight=1)
        output_frame.grid_rowconfigure(0, weight=1)
        self.output = tk.Text(
            output_frame,
            height=5,
            wrap="word",
            state="disabled",
            bg="#19191e",
            fg="#d2d0d7",
            insertbackground=colors["text"],
            selectbackground=colors["accent_dark"],
            relief="flat",
            borderwidth=0,
            padx=10,
            pady=8,
            font=("Consolas", 9),
            highlightthickness=1,
            highlightbackground=colors["border"],
            highlightcolor=colors["border"],
        )
        self.output.grid(row=0, column=0, sticky="nsew")
        self.output.tag_configure("url", foreground="#ff7791", underline=True)
        self.output.bind("<Button-1>", self._copy_clicked_url)

    def _build_sidebar(self, sidebar: tk.Frame) -> None:
        colors = self.COLORS
        brand = tk.Frame(sidebar, bg=colors["sidebar"], padx=19, pady=22)
        brand.pack(fill="x")
        mark = tk.Canvas(brand, width=39, height=39, bg=colors["sidebar"], highlightthickness=0)
        mark.pack(side="left")
        mark.create_oval(2, 2, 37, 37, fill=colors["accent"], outline="")
        mark.create_text(20, 19, text="♪", fill="white", font=("Segoe UI", 20, "bold"))
        brand_name = tk.Frame(brand, bg=colors["sidebar"])
        brand_name.pack(side="left", padx=(9, 0))
        tk.Label(
            brand_name,
            text="BitSeek",
            font=("Segoe UI", 15, "bold"),
            fg=colors["text"],
            bg=colors["sidebar"],
        ).pack(anchor="w")
        tk.Label(
            brand_name,
            text="FOR BITCHORD",
            font=("Segoe UI", 7, "bold"),
            fg=colors["muted"],
            bg=colors["sidebar"],
        ).pack(anchor="w")

        tk.Label(
            sidebar,
            text="WORKSPACE",
            font=("Segoe UI", 8, "bold"),
            fg=colors["subtle"],
            bg=colors["sidebar"],
            padx=20,
        ).pack(anchor="w", pady=(26, 9))
        self.nav_button = tk.Button(
            sidebar,
            text="  ♫    Player setup",
            anchor="w",
            command=lambda: None,
            bg="#35202a",
            fg="#ff6d89",
            activebackground="#35202a",
            activeforeground="#ff6d89",
            relief="flat",
            bd=0,
            padx=12,
            pady=11,
            font=("Segoe UI", 10, "bold"),
            cursor="arrow",
        )
        self.nav_button.pack(fill="x", padx=12)

        spacer = tk.Frame(sidebar, bg=colors["sidebar"])
        spacer.pack(fill="both", expand=True)
        tk.Frame(sidebar, bg=colors["border"], height=1).pack(fill="x", padx=17, pady=(0, 15))
        tk.Label(
            sidebar,
            text="SOULSEEK  •  BITCHORD",
            font=("Segoe UI", 8, "bold"),
            fg=colors["muted"],
            bg=colors["sidebar"],
            padx=20,
        ).pack(anchor="w")
        tk.Label(
            sidebar,
            text=f"Build {__version__}",
            font=("Segoe UI", 8),
            fg=colors["subtle"],
            bg=colors["sidebar"],
            padx=20,
        ).pack(anchor="w", pady=(5, 20))

    def _card(self, parent: tk.Widget, padding: int = 16) -> tk.Frame:
        card = tk.Frame(parent, bg=self.COLORS["surface"], padx=padding, pady=padding)
        card.configure(highlightthickness=1, highlightbackground=self.COLORS["border"])
        return card

    def _field_label(self, parent: tk.Widget, text: str) -> None:
        tk.Label(
            parent,
            text=text.upper(),
            font=("Segoe UI", 8, "bold"),
            fg=self.COLORS["muted"],
            bg=self.COLORS["surface"],
        ).pack(anchor="w", pady=(9, 5))

    def _entry(self, parent: tk.Widget, variable: tk.StringVar, show: str | None = None) -> tk.Entry:
        entry = tk.Entry(
            parent,
            textvariable=variable,
            show=show or "",
            bg=self.COLORS["surface_alt"],
            fg=self.COLORS["text"],
            insertbackground=self.COLORS["text"],
            selectbackground=self.COLORS["accent_dark"],
            relief="flat",
            borderwidth=0,
            highlightthickness=1,
            highlightbackground=self.COLORS["border"],
            highlightcolor=self.COLORS["accent"],
            font=("Segoe UI", 9),
        )
        entry.pack(fill="x", ipady=8)
        return entry

    def _action_button(
        self,
        parent: tk.Widget,
        text: str,
        command,
        *,
        primary: bool = False,
        width: int | None = None,
    ) -> tk.Button:
        background = self.COLORS["accent"] if primary else self.COLORS["surface_alt"]
        active = self.COLORS["accent_dark"] if primary else self.COLORS["surface_hover"]
        button = tk.Button(
            parent,
            text=text,
            command=command,
            bg=background,
            fg="white" if primary else self.COLORS["text"],
            activebackground=active,
            activeforeground="white",
            disabledforeground=self.COLORS["subtle"],
            relief="flat",
            bd=0,
            padx=13,
            pady=7,
            font=("Segoe UI", 9, "bold"),
            cursor="hand2",
            width=width,
        )
        return button

    def _build_service_card(self, card: tk.Frame) -> None:
        colors = self.COLORS
        header = tk.Frame(card, bg=colors["surface"])
        header.pack(fill="x")
        tk.Label(
            header,
            text="01",
            font=("Segoe UI", 10, "bold"),
            fg=colors["accent"],
            bg=colors["surface"],
        ).pack(side="left")
        tk.Label(
            header,
            text="  SOULSEEK CONNECTION",
            font=("Segoe UI", 9, "bold"),
            fg=colors["text"],
            bg=colors["surface"],
        ).pack(side="left")

        self._field_label(card, "slskd application")
        path_row = tk.Frame(card, bg=colors["surface"])
        path_row.pack(fill="x")
        path_entry = tk.Entry(
            path_row,
            textvariable=self.slskd_path,
            bg=colors["surface_alt"],
            fg=colors["text"],
            insertbackground=colors["text"],
            relief="flat",
            borderwidth=0,
            highlightthickness=1,
            highlightbackground=colors["border"],
            highlightcolor=colors["accent"],
            font=("Segoe UI", 9),
        )
        path_entry.pack(side="left", fill="x", expand=True, ipady=8)
        self._action_button(path_row, "Browse", self._browse_slskd).pack(side="left", padx=(7, 0))

        self._field_label(card, "Soulseek username")
        self._entry(card, self.username)
        self._field_label(card, "Soulseek password")
        self._entry(card, self.password, show="*")
        tk.Label(
            card,
            text="Private to this session · never saved",
            font=("Segoe UI", 8),
            fg=colors["subtle"],
            bg=colors["surface"],
        ).pack(anchor="w", pady=(8, 0))

    def _build_storage_card(self, card: tk.Frame) -> None:
        colors = self.COLORS
        header = tk.Frame(card, bg=colors["surface"])
        header.pack(fill="x")
        tk.Label(
            header,
            text="02",
            font=("Segoe UI", 10, "bold"),
            fg=colors["accent"],
            bg=colors["surface"],
        ).pack(side="left")
        tk.Label(
            header,
            text="  LIBRARY & STREAM",
            font=("Segoe UI", 9, "bold"),
            fg=colors["text"],
            bg=colors["surface"],
        ).pack(side="left")

        self._field_label(card, "download destination")
        path_row = tk.Frame(card, bg=colors["surface"])
        path_row.pack(fill="x")
        path_entry = tk.Entry(
            path_row,
            textvariable=self.downloads_dir,
            bg=colors["surface_alt"],
            fg=colors["text"],
            insertbackground=colors["text"],
            relief="flat",
            borderwidth=0,
            highlightthickness=1,
            highlightbackground=colors["border"],
            highlightcolor=colors["accent"],
            font=("Segoe UI", 9),
        )
        path_entry.pack(side="left", fill="x", expand=True, ipady=8)
        self._action_button(path_row, "Choose", self._browse_downloads).pack(side="left", padx=(7, 0))

        self._field_label(card, "public address")
        self._entry(card, self.public_url)
        self.funnel_check = tk.Checkbutton(
            card,
            text="Start Tailscale Funnel",
            variable=self.start_funnel,
            bg=colors["surface"],
            fg=colors["text"],
            activebackground=colors["surface"],
            activeforeground=colors["text"],
            selectcolor=colors["surface_alt"],
            font=("Segoe UI", 9),
            highlightthickness=0,
            bd=0,
            cursor="hand2",
        )
        self.funnel_check.pack(anchor="w", pady=(9, 0))
        tk.Label(
            card,
            text="Use Funnel for a public HTTPS .ts.net address.",
            font=("Segoe UI", 8),
            fg=colors["subtle"],
            bg=colors["surface"],
        ).pack(anchor="w", padx=(22, 0), pady=(2, 0))

        actions = tk.Frame(card, bg=colors["surface"])
        actions.pack(fill="x", pady=(16, 0))
        self.start_button = self._action_button(actions, "▶   Start listening", self.start, primary=True)
        self.start_button.pack(side="left", fill="x", expand=True)
        self.stop_button = self._action_button(actions, "Stop", self.stop)
        self.stop_button.configure(state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))

    def _draw_hero(self, _event=None) -> None:
        canvas = self.hero
        width = max(canvas.winfo_width(), 2)
        height = max(canvas.winfo_height(), 2)
        canvas.delete("all")
        left = (250, 49, 92)
        right = (114, 35, 101)
        for x in range(width):
            ratio = x / max(width - 1, 1)
            shade = tuple(int(a + (b - a) * ratio) for a, b in zip(left, right))
            color = "#%02x%02x%02x" % shade
            canvas.create_line(x, 0, x, height, fill=color)

        canvas.create_oval(width - 226, -95, width - 18, 113, fill="#a83768", outline="")
        canvas.create_oval(width - 198, -67, width - 46, 85, outline="#e787a3", width=2)
        canvas.create_oval(width - 166, -35, width - 78, 53, outline="#f2a4b9", width=1)
        canvas.create_oval(width - 137, -6, width - 107, 24, fill="#ffb5c3", outline="")
        canvas.create_text(
            26,
            30,
            text="BITSEEKWIN  /  BITCHORD",
            anchor="w",
            fill="#ffe5eb",
            font=("Segoe UI", 8, "bold"),
        )
        canvas.create_text(
            25,
            67,
            text="Your music,",
            anchor="w",
            fill="white",
            font=("Segoe UI", 23, "bold"),
        )
        canvas.create_text(
            25,
            99,
            text="connected.",
            anchor="w",
            fill="white",
            font=("Segoe UI", 23, "bold"),
        )
        canvas.create_text(
            27,
            133,
            text="Search Soulseek  ·  Queue a FLAC  ·  Listen in BitChord",
            anchor="w",
            fill="#ffe5eb",
            font=("Segoe UI", 9),
        )

    def _copy_clicked_url(self, event) -> None:
        index = self.output.index(f"@{event.x},{event.y}")
        if "url" in self.output.tag_names(index) and self.source_url.get():
            self._copy_source_url()

    def _copy_source_url(self) -> None:
        if not self.source_url.get():
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.source_url.get())
        self.status_detail.set("Source URL copied")
        self.status_label.configure(fg=self.COLORS["green"])

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
        marker = "Add this source in BitChord: "
        source_url = text.split(marker, 1)[1].strip() if marker in text else ""
        if source_url:
            self.source_url.set(source_url)
            self.copy_url_button.configure(state="normal")
        self.output.configure(state="normal")
        if source_url:
            before, after = text.split(source_url, 1)
            self.output.insert("end", before)
            start = self.output.index("end-1c")
            self.output.insert("end", source_url)
            end = self.output.index("end-1c")
            self.output.tag_add("url", start, end)
            self.output.insert("end", after.rstrip() + "\n")
        else:
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
        self.password.set("")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="disabled")
        self.status.set("Starting slskd and BitSeekWin…")
        self.status_detail.set("Connecting")
        self.status_label.configure(fg=self.COLORS["accent"])
        self.status_dot.configure(fg=self.COLORS["accent"])
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
        self.status_detail.set("Stopping")
        self.status_label.configure(fg=self.COLORS["accent"])
        self.status_dot.configure(fg=self.COLORS["accent"])
        _terminate_process(self.server_process)
        _terminate_process(self.slskd_process)
        self.server_process = None
        self.slskd_process = None
        self.starting = False
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        self.status.set("Stopped. Tailscale Funnel, if enabled, remains configured.")
        self.status_detail.set("Stopped")
        self.status_label.configure(fg=self.COLORS["muted"])
        self.status_dot.configure(fg=self.COLORS["subtle"])
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
                self.status_detail.set("Listening")
                self.status_label.configure(fg=self.COLORS["green"])
                self.status_dot.configure(fg=self.COLORS["green"])
                self.stop_button.configure(state="normal")
            elif kind == "error":
                self.starting = False
                self.status.set("Startup failed.")
                self.status_detail.set("Needs attention")
                self.status_label.configure(fg=self.COLORS["accent"])
                self.status_dot.configure(fg=self.COLORS["accent"])
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
