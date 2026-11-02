# 大谷の公開動画を1本ずつ文字にする。結果は private/ に置き、全文は公開しない。
import pathlib, subprocess, sys, time
from faster_whisper import WhisperModel

OUT = pathlib.Path("private/transcripts")
AUDIO = pathlib.Path("private/audio")
AUDIO.mkdir(parents=True, exist_ok=True)
model = WhisperModel("small", device="cpu", compute_type="int8")

for video_id in sys.argv[1:]:
    target = OUT / f"{video_id}.txt"
    if target.exists():
        continue
    audio = AUDIO / f"{video_id}.m4a"
    if not audio.exists():
        subprocess.run([sys.executable, "-m", "yt_dlp", "-q", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio",
                        "-o", str(audio), f"https://www.youtube.com/watch?v={video_id}"], check=True)
        time.sleep(5)
    segments, _ = model.transcribe(str(audio), language="ja", vad_filter=True)
    lines = [f"{int(s.start) // 60:02d}:{int(s.start) % 60:02d} {s.text.strip()}" for s in segments]
    target.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(video_id, len(lines), flush=True)
