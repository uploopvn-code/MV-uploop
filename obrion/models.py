"""Strict production contracts; no invented defaults for creative direction."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Timecode(Model):
    start_seconds: float = Field(ge=0)
    duration_seconds: float = Field(gt=0, le=600)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def arithmetic(self):
        if abs(self.start_seconds + self.duration_seconds - self.end_seconds) > 0.001:
            raise ValueError("end_seconds phải bằng start_seconds + duration_seconds")
        return self


class Continuity(Model):
    screen_direction: str = Field(min_length=1)
    eyeline_vector: str = Field(min_length=1)
    cut_transition: str = Field(min_length=1)


class Assets(Model):
    primary_character: str
    character_lora_tag: str


class Cinematography(Model):
    camera_id: str = Field(min_length=1)
    rig: str = Field(min_length=1)
    movement: str = Field(min_length=1)
    focal_length: str = Field(min_length=1)
    framing: str = Field(min_length=1)


class Performance(Model):
    intensity_score: float = Field(ge=0, le=1)
    gaze_action: str = Field(min_length=1)
    micro_expressions: str = Field(min_length=1)


class Dialogue(Model):
    speaker: str
    text: str
    delivery_tag: str


class Audio(Model):
    dialogue: Dialogue
    foley: list[str]
    ambience: str


class NarrativeShot(Model):
    shot_id: str = Field(min_length=1)
    scene_id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    timecode: Timecode
    beat: str = Field(min_length=1)
    pacing_mode: Literal["dread_oner", "asymmetric_beat", "staccato", "dynamic"]
    continuity_rules: Continuity
    generation_assets: Assets


class Shot(NarrativeShot):
    cinematography: Cinematography
    performance_direction: Performance
    audio_stems: Audio
    videoPrompt: str = Field(min_length=1)
    first_frame_reference_url: str


class Narrative(Model):
    shots: list[NarrativeShot] = Field(min_length=1, max_length=300)


class CameraRow(Model):
    shot_id: str
    cinematography: Cinematography


class Cameras(Model):
    shots: list[CameraRow]


class PerformanceRow(Model):
    shot_id: str
    performance_direction: Performance


class Performances(Model):
    shots: list[PerformanceRow]


class SoundRow(Model):
    shot_id: str
    audio_stems: Audio


class Sounds(Model):
    shots: list[SoundRow]


class PromptRow(Model):
    shot_id: str
    videoPrompt: str = Field(min_length=1)
    first_frame_reference_url: str


class Prompts(Model):
    shots: list[PromptRow]


class Production(Model):
    title: str = Field(min_length=1)
    shots: list[Shot] = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def timeline(self):
        ids, end = set(), 0.0
        for shot in self.shots:
            if shot.shot_id in ids:
                raise ValueError(f"Trùng shot_id: {shot.shot_id}")
            ids.add(shot.shot_id)
            if abs(shot.timecode.start_seconds - end) > 0.001:
                raise ValueError(f"{shot.shot_id}: timeline phải liên tục, bắt đầu tại {end}s")
            end = shot.timecode.end_seconds
        return self
