"""Local retrieval memory: lexical similarity, per specialist, deduplicated corrections."""
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager


class Memory:
    def __init__(self, filename):
        self.filename = str(filename)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, context TEXT NOT NULL, corrected TEXT NOT NULL)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.filename, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self, original, corrected):
        from models import Production
        original = Production.model_validate(original).model_dump()
        corrected = Production.model_validate(corrected).model_dump()
        before = {s["shot_id"]: s for s in original["shots"]}
        count = 0
        with self.connect() as db:
            for shot in corrected["shots"]:
                old = before.get(shot["shot_id"])
                if old is None or old == shot:
                    continue
                context = json.dumps(old, ensure_ascii=False, sort_keys=True)
                output = json.dumps(shot, ensure_ascii=False, sort_keys=True)
                key = hashlib.sha256((context + output).encode()).hexdigest()
                count += db.execute("INSERT OR IGNORE INTO feedback VALUES (?, ?, ?)", (key, context, output)).rowcount
        return count

    def retrieve(self, query, field=None, limit=3):
        tokens = set(re.findall(r"\w+", query.lower()))
        ranked = []
        with self.connect() as db:
            for context, corrected in db.execute("SELECT context, corrected FROM feedback"):
                before, after = json.loads(context), json.loads(corrected)
                if field and before.get(field) == after.get(field):
                    continue
                words = set(re.findall(r"\w+", context.lower()))
                score = len(tokens & words) / max(1, len(tokens | words))
                if score:
                    ranked.append((score, {"original_context": before, "human_corrected_output": after}))
        return [row for _, row in sorted(ranked, key=lambda pair: pair[0], reverse=True)[:limit]]
