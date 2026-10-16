import copy
import json
from pathlib import Path
import tempfile
import unittest
import opentimelineio as otio
from models import Production
from memory import Memory
from graph import build_workflow
from export import export_otio


SHOT = {
    "shot_id": "E02-S1-01", "scene_id": "hangar", "description": "Ami giấu tấm thẻ vào áo.",
    "timecode": {"start_seconds": 0, "duration_seconds": 3, "end_seconds": 3},
    "beat": "setup", "pacing_mode": "asymmetric_beat",
    "continuity_rules": {"screen_direction": "L_to_R", "eyeline_vector": "45_degrees_screen_left", "cut_transition": "Hard cut"},
    "generation_assets": {"primary_character": "ami", "character_lora_tag": ""},
    "cinematography": {"camera_id": "cam_cu", "rig": "Locked Tripod", "movement": "Static hold", "focal_length": "65mm", "framing": "Frame-right profile"},
    "performance_direction": {"intensity_score": 0.45, "gaze_action": "Locked unblinking", "micro_expressions": "AU4, compressed lips"},
    "audio_stems": {"dialogue": {"speaker": "ami", "text": "Giấu nó đi.", "delivery_tag": "whisper"}, "foley": ["card_friction"], "ambience": "desert_wind"},
    "videoPrompt": "Ami hides the card. Static hold, restrained AU4. Whisper: Giấu nó đi. Gritty realism.",
    "first_frame_reference_url": ""
}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.memory = Memory(Path(self.temp.name) / "memory.sqlite3")

    def tearDown(self):
        self.temp.cleanup()

    def production(self):
        return {"title": "OBRION", "shots": [copy.deepcopy(SHOT)]}

    def generator(self, failures=None, always=False):
        calls = []
        failures = failures or {}
        def generate(name, schema, system, context):
            calls.append(name)
            if name in failures and (always or calls.count(name) <= failures[name]):
                return {"shots": []}
            fields = schema.model_fields["shots"].annotation.__args__[0].model_fields
            return {"shots": [{k: copy.deepcopy(v) for k, v in SHOT.items() if k in fields}]}
        return generate, calls

    def invoke(self, generate):
        return build_workflow(generate, self.memory, lambda _: None).invoke({
            "raw_script": "Ami: Giấu nó đi.", "asset_bible": {}, "title": "OBRION", "current_scene": {},
            "generated_shots": [], "validation_errors": [], "retry_count": 0,
        }, {"recursion_limit": 50})

    def test_full_workflow_and_otio_roundtrip(self):
        generate, calls = self.generator()
        result = self.invoke(generate)
        self.assertEqual(len(calls), 5)
        timeline = otio.adapters.read_from_string(result["otio"], "otio_json")
        self.assertEqual(timeline.duration().to_seconds(), 3)
        self.assertEqual(timeline.tracks[0][0].metadata["obrion"]["shot_id"], SHOT["shot_id"])

    def test_retry_failed_specialist_only(self):
        generate, calls = self.generator({"Agent_Cinematography": 1})
        result = self.invoke(generate)
        self.assertEqual(result["retry_count"], 1)
        self.assertEqual(calls.count("Agent_Narrative"), 1)
        self.assertEqual(calls.count("Agent_Cinematography"), 2)

    def test_retry_exhaustion_never_exports(self):
        generate, calls = self.generator({"Agent_Cinematography": 1}, always=True)
        with self.assertRaisesRegex(ValueError, "3 lần"):
            self.invoke(generate)
        self.assertEqual(calls.count("Agent_Cinematography"), 4)
        self.assertNotIn("Agent_Prompt", calls)

    def test_timeline_duplicate_nan_and_intensity(self):
        for mutate in [
            lambda p: p["shots"][0]["timecode"].update(end_seconds=10),
            lambda p: p["shots"][0]["timecode"].update(start_seconds=1, end_seconds=4),
            lambda p: p["shots"].append(copy.deepcopy(SHOT)),
            lambda p: p["shots"][0]["performance_direction"].update(intensity_score=1.1),
            lambda p: p["shots"][0]["timecode"].update(duration_seconds=float("nan")),
        ]:
            p = self.production()
            mutate(p)
            with self.assertRaises(ValueError):
                Production.model_validate(p)

    def test_memory_dedupe_and_specialist_filter(self):
        original, corrected = self.production(), self.production()
        corrected["shots"][0]["cinematography"]["movement"] = "Slow push in"
        self.assertEqual(self.memory.ingest(original, corrected), 1)
        self.assertEqual(self.memory.ingest(original, corrected), 0)
        self.assertEqual(len(self.memory.retrieve("Ami card hangar", "cinematography")), 1)
        self.assertEqual(self.memory.retrieve("Ami", "performance_direction"), [])
        self.assertEqual(self.memory.ingest(original, original), 0)

    def test_memory_injected(self):
        original, corrected = self.production(), self.production()
        corrected["shots"][0]["cinematography"]["movement"] = "Slow push in"
        self.memory.ingest(original, corrected)
        generate, _ = self.generator()
        seen = []
        def capture(name, schema, system, context):
            if name == "Agent_Cinematography":
                seen.extend(json.loads(context)["approved_examples"])
            return generate(name, schema, system, context)
        self.invoke(capture)
        self.assertEqual(seen[0]["human_corrected_output"]["cinematography"]["movement"], "Slow push in")


if __name__ == "__main__":
    unittest.main()
