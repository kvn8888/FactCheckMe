"""Isolated CPU runner for the live STT benchmark. Started only by --live."""

import hashlib
import json
import math
from pathlib import Path
import sys
import time
from urllib.request import urlopen


MODEL = "benjamin/wtp-bert-mini"
REVISION = "ac9218133a447014fa557a9997a1422def9bc6e8"
GRAPH_SHA256 = "8f2e2ada50239bef37469e4187b209c70d141e02f193cdfb5436e2ed6070479a"
PRIMES = (31, 43, 59, 61, 73, 97, 103, 113)
STRIDE = 64
LEFT_CONTEXT = 96
LOOKAHEAD = 28
DEFAULT_THRESHOLD = 0.01
THRESHOLDS = (0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85)

# Known boundaries in independent examples. The benchmark transcripts and their
# reference never participate in the operating threshold selection.
CALIBRATION = (
    ('Dr. Lee reviewed the notes from Jan. 12.', 'The visit lasted 3.5 hours.', 'Did you log the visit?'),
    ('The branch is located in the U.S.', 'Its staff also answer calls from Canada.'),
    ('Avery Wren, Ph.D., designed the trial.', 'A paper described the method.', 'Try the example at home.'),
    ('The plan lists Northmill Inc. as a sponsor.', 'They said "hold on," then continued.', 'Here is the result.'),
    ('I wanted to say this... before I forgot.', 'The total was 87.3 percent.', 'What was yours?'),
    ('The wind picked up and the sky grew dark', 'We headed indoors.', 'The rain lasted only a minute.'),
    ('Avery picked up the bag. And handed it to Sam.', 'The two of them walked to the station.'),
)


def ms(start):
    return round((time.perf_counter() - start) * 1000, 3)


def download(name):
    url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}?download=true"
    with urlopen(url, timeout=30) as response:
        return response.read()


class Splitter:
    def __init__(self, session, config, np):
        self.session = session
        self.np = np
        self.block_size = config["max_position_embeddings"]
        self.downsampling = config.get("downsampling_rate", 1)
        self.buckets = config["num_hash_buckets"]
        self.primes = np.array(PRIMES[: config["num_hash_functions"]], dtype=np.int64)

    def probabilities(self, text):
        # WtP character encoding, overlapping windows and uniform logit averaging.
        # The final window goes flush against the right edge, as in wtpsplit.extract.
        np = self.np
        size = len(text)
        if not size:
            return np.empty(0, dtype=np.float32)
        block = math.ceil(min(size, self.block_size) / self.downsampling) * self.downsampling
        starts = [min(offset, max(0, size - block))
                  for offset in range(0, max(0, size - block) + STRIDE, STRIDE)]
        ordinals = np.frombuffer(text.encode("utf-32-le"), dtype="<u4").astype(np.int64)
        hashes = ((ordinals[:, None] + 1) * self.primes) % self.buckets
        counts = np.zeros(size, dtype=np.float16)
        summed = np.zeros(size, dtype=np.float16)
        for first in range(0, len(starts), 32):
            batch = starts[first:first + 32]
            inputs = np.zeros((len(batch), block, len(self.primes)), dtype=np.int64)
            mask = np.zeros((len(batch), block), dtype=np.float16)
            width = min(size, block)
            for row, start in enumerate(batch):
                inputs[row, :width] = hashes[start:start + width]
                mask[row, :width] = 1
            logits, = self.session.run(["logits"], {"hashed_ids": inputs, "attention_mask": mask})
            for row, start in enumerate(batch):
                summed[start:start + width] += logits[row, :width, 0]
                counts[start:start + width] += 1
        averaged = (summed / counts).astype(np.float32)
        return 1 / (1 + np.exp(-averaged))

    def ends(self, text, probabilities, threshold):
        # A newline prediction labels the preceding character. Project boundaries
        # onto trimmed spans, preserving all source text, including punctuation.
        ends = []
        for index in self.np.flatnonzero(probabilities > threshold):
            end = int(index) + 1
            while end > 0 and text[end - 1].isspace():
                end -= 1
            if end and (not ends or end != ends[-1]):
                ends.append(end)
        return ends


def calibrate(splitter):
    examples = []
    for sentences in CALIBRATION:
        text = " ".join(sentences)
        expected = set()
        cursor = 0
        for sentence in sentences[:-1]:
            cursor += len(sentence)
            expected.add(cursor)
            cursor += 1
        examples.append((text, expected, splitter.probabilities(text)))

    scores = []
    for threshold in THRESHOLDS:
        matched = predicted = labeled = 0
        for text, expected, probabilities in examples:
            ends = set(splitter.ends(text, probabilities, threshold)) - {len(text)}
            matched += len(ends & expected)
            predicted += len(ends)
            labeled += len(expected)
        scores.append({
            "threshold": threshold, "matched": matched, "predicted": predicted, "labeled": labeled,
            "f1": 2 * matched / (predicted + labeled),
        })
    winner = max(scores, key=lambda score: (
        score["f1"], -abs(math.log(score["threshold"] / DEFAULT_THRESHOLD))))
    return {"threshold": winner["threshold"], "defaultThreshold": DEFAULT_THRESHOLD, "scores": scores}


def utf16_offsets(text):
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xffff else 1))
    return offsets


def benchmark(splitter, data, threshold):
    final_text = data["text"]
    offsets = utf16_offsets(final_text)
    started = time.perf_counter()
    final_ends = splitter.ends(final_text, splitter.probabilities(final_text), threshold)
    final_ms = ms(started)

    cursor = 0
    locked = []
    times = []
    for update in data["updates"]:
        text = update["text"]
        if len(text) <= cursor:
            continue
        start = max(0, cursor - LEFT_CONTEXT)
        window = text[start:]
        started = time.perf_counter()
        ends = splitter.ends(window, splitter.probabilities(window), threshold)
        times.append(ms(started))
        # JS supplies the end of the contiguous finalized prefix in code points.
        # Partial deltas still supply right context and exercise the warm model.
        limit = min(update["stableChars"], len(text) - LOOKAHEAD)
        for local in ends:
            end = start + local
            if cursor < end <= limit:
                locked.append({"end": offsets[end], "atMs": update["atMs"]})
                cursor = end

    # Flush the outstanding window with all actual text available at EOF.
    # Re-run with the same left context used by the streaming replay.
    start = max(0, cursor - LEFT_CONTEXT)
    window = final_text[start:]
    started = time.perf_counter()
    ends = splitter.ends(window, splitter.probabilities(window), threshold)
    eof_ms = ms(started)
    for end in sorted(set(start + value for value in ends) | {len(final_text)}):
        if end > cursor:
            locked.append({"end": offsets[end], "atMs": data["eofMs"], "eof": True})
    return {
        "id": data["id"], "finalEnds": [offsets[end] for end in final_ends], "finalMs": final_ms,
        "rollingEnds": locked, "rollingMs": times, "eofMs": eof_ms,
    }


def main(directory):
    stage = "imports"
    result = {"model": MODEL, "revision": REVISION}
    try:
        started = time.perf_counter()
        import numpy as np
        import onnxruntime as ort

        result["importMs"] = ms(started)
        stage = "model download"
        started = time.perf_counter()
        config = json.loads(download("config.json"))
        graph = download("model.onnx")
        result["downloadMs"] = ms(started)
        if hashlib.sha256(graph).hexdigest() != GRAPH_SHA256:
            raise ValueError("Unexpected ONNX graph checksum")
        graph_path = directory / "model.onnx"
        graph_path.write_bytes(graph)
        result["graphBytes"] = len(graph)
        del graph

        stage = "ONNX load"
        started = time.perf_counter()
        settings = ort.SessionOptions()
        settings.intra_op_num_threads = 2
        settings.inter_op_num_threads = 1
        settings.log_severity_level = 3
        session = ort.InferenceSession(str(graph_path), sess_options=settings, providers=["CPUExecutionProvider"])
        result["loadMs"] = ms(started)
        inputs = {item.name: item.type for item in session.get_inputs()}
        if inputs != {"attention_mask": "tensor(float16)", "hashed_ids": "tensor(int64)"}:
            raise ValueError("Unexpected ONNX input contract")
        result.update({"runtime": ort.__version__, "inputs": inputs, "threads": 2, "stride": STRIDE,
                       "blockSize": config["max_position_embeddings"], "lookahead": LOOKAHEAD,
                       "leftContext": LEFT_CONTEXT})
        splitter = Splitter(session, config, np)

        stage = "ONNX warmup"
        started = time.perf_counter()
        splitter.probabilities("The first warmup sentence ends here. The second begins.")
        result["warmupMs"] = ms(started)
        stage = "independent threshold calibration"
        started = time.perf_counter()
        result["calibration"] = calibrate(splitter)
        result["calibrationMs"] = ms(started)
        result["ready"] = True

        stage = "transcript replay"
        data = json.load(sys.stdin)
        result["providers"] = [
            benchmark(splitter, provider, result["calibration"]["threshold"]) for provider in data if provider["text"]
        ]
        result["status"] = "ok"
    except Exception as error:
        # Never serialize exception text, HTTP bodies, or environment values.
        result.update({"status": "unavailable", "error": {"stage": stage, "type": type(error).__name__}})
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
