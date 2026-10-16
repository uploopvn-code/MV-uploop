import opentimelineio as otio
from models import Production


def export_otio(production):
    production = Production.model_validate(production)
    timeline = otio.schema.Timeline(name=production.title)
    track = otio.schema.Track(name="OBRION shots", kind=otio.schema.TrackKind.Video)
    timeline.tracks.append(track)
    for shot in production.shots:
        duration = otio.opentime.RationalTime(shot.timecode.duration_seconds * 24, 24)
        track.append(otio.schema.Clip(
            name=shot.shot_id,
            media_reference=otio.schema.MissingReference(),
            source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, 24), duration),
            metadata={"obrion": shot.model_dump()},
        ))
    return otio.adapters.write_to_string(timeline, "otio_json")
