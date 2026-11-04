from pathlib import Path

__version__ = Path(__file__).with_name("version.txt").read_text().strip()
