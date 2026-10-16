import argparse
import json
from pathlib import Path
from memory import Memory

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Lưu các shot đã được đạo diễn chỉnh sửa")
    parser.add_argument("original")
    parser.add_argument("corrected")
    parser.add_argument("--memory", default="director_memory.sqlite3")
    args = parser.parse_args()
    read = lambda p: json.loads(Path(p).read_text(encoding="utf-8-sig"))
    print(f"Đã lưu {Memory(args.memory).ingest(read(args.original), read(args.corrected))} phản hồi mới.")
