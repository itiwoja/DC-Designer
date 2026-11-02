"""VOICEVOX ENGINE（127.0.0.1:50021）でナレーションを作る。
uv run --with requests python scripts/voice_vv.py narration/lines.json public/vo --speaker 8 [--intonation 1.2 --speed 0.9 --pitch 0]（8 は春日部つむぎ。README の作り直し方と同じ）
lines.json は [[id, 文], ...]。3 つ目に {"pauses": [秒, ...]} を付けると、文の中の区切り（・や。）の間を前から順にその長さにする
出力：<id>.ogg（48kHz mono、前後の無音を切り、-16 LUFS）と durations.json（秒）
"""
import argparse, json, subprocess, tempfile
from pathlib import Path
import requests

ap = argparse.ArgumentParser()
ap.add_argument("lines"); ap.add_argument("out")
ap.add_argument("--speaker", type=int, default=8); ap.add_argument("--intonation", type=float, default=1.2)
ap.add_argument("--speed", type=float, default=0.9); ap.add_argument("--pitch", type=float, default=0.0)
a = ap.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
U = "http://127.0.0.1:50021"; meta = {}
for i, text, *opt in json.loads(Path(a.lines).read_text()):
    opt = opt[0] if opt else {}
    q = requests.post(f"{U}/audio_query", params={"text": text, "speaker": a.speaker}).json()
    q.update(intonationScale=a.intonation, speedScale=a.speed, pitchScale=a.pitch, prePhonemeLength=0.05, postPhonemeLength=0.05, outputSamplingRate=48000)
    pauses = [p for p in q["accent_phrases"] if p.get("pause_mora")]
    for p, sec in zip(pauses, opt.get("pauses", [])):
        p["pause_mora"]["vowel_length"] = sec
    with tempfile.NamedTemporaryFile(suffix=".wav") as raw:
        raw.write(requests.post(f"{U}/synthesis", params={"speaker": a.speaker}, json=q).content); raw.flush()
        dst = out / f"{i}.ogg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw.name, "-af",
            "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-2",
            "-ar", "48000", "-ac", "1", "-c:a", "libvorbis", "-q:a", "6", str(dst)], check=True)
    meta[i] = round(float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(dst)])), 3)
    print(f"{i}\t{meta[i]:.2f}s\t{len(text)}字\t{len(text)/meta[i]:.1f}字/秒")
(out / "durations.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
print("合計", round(sum(meta.values()), 2))
