"""CLI and stdin/stdout bridge. Credentials never go in process arguments."""
import argparse
import json
import os
from pathlib import Path
import sys


def execute(request, log=lambda text: print(text, file=sys.stderr, flush=True)):
    from models import Production
    from memory import Memory
    from export import export_otio
    action = request.get("action", "generate")
    if action == "check":
        import langgraph.graph
        import langchain_openai
        return {"ready": True, "python": sys.version.split()[0]}
    if action == "validate":
        production = Production.model_validate(request["production"]).model_dump()
        return {"production": production, "otio": export_otio(production)}
    memory = Memory(request.get("memory", "director_memory.sqlite3"))
    if action == "feedback":
        return {"saved": memory.ingest(request["original"], request["corrected"])}
    if action != "generate":
        raise ValueError("Tác vụ không hợp lệ")
    raw = request.get("raw_script", "")
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 100000:
        raise ValueError("Kịch bản phải có 1–100000 ký tự")
    bible = request.get("asset_bible", {})
    if not isinstance(bible, dict):
        raise ValueError("Asset Bible phải là JSON object")
    cfg = request.get("llm", {})
    if cfg.get("provider") == "anthropic":
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model=cfg.get("model") or os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
                            api_key=cfg.get("key") or os.environ.get("ANTHROPIC_API_KEY"), timeout=180, max_retries=0, max_tokens=16000)
    else:
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model=cfg.get("model") or os.environ.get("OPENAI_MODEL", "gpt-4o"),
                         api_key=cfg.get("key") or os.environ.get("OPENAI_API_KEY"),
                         base_url=cfg.get("baseUrl") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1",
                         timeout=180, max_retries=0)
    def generate(name, schema, system, user):
        return llm.with_structured_output(schema).invoke([("system", system), ("human", user)])
    from graph import build_workflow
    state = build_workflow(generate, memory, log).invoke({
        "raw_script": raw, "asset_bible": bible, "title": request.get("title") or "OBRION",
        "camera_rules": request.get("camera_rules", ""), "emotion_rules": request.get("emotion_rules", ""),
        "current_scene": {}, "generated_shots": [], "validation_errors": [], "retry_count": 0,
    }, {"recursion_limit": 50})
    return {"production": {"title": state["title"], "shots": state["generated_shots"]}, "otio": state["otio"], "retries": state["retry_count"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", action="store_true")
    parser.add_argument("--script")
    parser.add_argument("--bible")
    parser.add_argument("--camera-rules")
    parser.add_argument("--emotion-rules")
    parser.add_argument("--title", default="OBRION")
    parser.add_argument("--provider", choices=["openai", "anthropic"], default="openai")
    parser.add_argument("--model")
    parser.add_argument("--memory", default="director_memory.sqlite3")
    parser.add_argument("--output", default="obrion-output")
    args = parser.parse_args()
    if args.bridge:
        try:
            print(json.dumps(execute(json.load(sys.stdin)), ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            sys.exit(1)
        return
    if not args.script:
        parser.error("Cần --script input_script.txt")
    read = lambda filename: Path(filename).read_text(encoding="utf-8-sig") if filename else ""
    result = execute({"raw_script": read(args.script), "asset_bible": json.loads(read(args.bible) or "{}"),
                      "camera_rules": read(args.camera_rules), "emotion_rules": read(args.emotion_rules),
                      "title": args.title, "memory": args.memory, "llm": {"provider": args.provider, "model": args.model}})
    target = Path(args.output)
    target.mkdir(parents=True, exist_ok=True)
    (target / "shots.json").write_text(json.dumps(result["production"], ensure_ascii=False, indent=2), encoding="utf-8")
    (target / "timeline.otio").write_text(result["otio"], encoding="utf-8")
    print(f"Đã lưu: {target.resolve()}")


if __name__ == "__main__":
    main()
