"""Independent interop peer using the original Muse Python SDK (test-only).

Set MUSE_GADGET_SDK to its checkout and MUSE_TEST_PYTHON to a Python executable
with cryptography and websockets installed. No credentials or network services
are used; the server binds an ephemeral loopback port.
"""
import asyncio
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(os.environ["MUSE_GADGET_SDK"]) / "linux" / "src"))
from websockets.asyncio.server import serve
from musegadget.noise.noise_xx import NoiseXXResponder
from musegadget.noise.framing import NoiseFrameDecoder, encode_noise_frames
from musegadget.noise.transport import decode_request_envelope, encode_response_envelope
from musegadget.noise.envelope import ServiceFrame, ApplicationResponse, BodyChunk, Reset


async def handle(ws):
    noise = NoiseXXResponder()
    noise.initialize()
    await ws.send(noise.read_message1_and_write_message2(await ws.recv()))
    noise.read_message3(await ws.recv())
    tx, rx = noise.split()
    assembler = NoiseFrameDecoder()

    async def send(frame, reverse=False):
        chunks = encode_noise_frames(encode_response_envelope(frame))
        if reverse:
            chunks.reverse()
        for chunk in chunks:
            await ws.send(tx.encrypt_with_ad(b"", chunk))

    async for packet in ws:
        plain = assembler.decode(rx.decrypt_with_ad(b"", packet))
        if plain is None:
            continue
        frame = decode_request_envelope(plain)
        if frame.kind == "reset":
            continue
        assert frame.kind == "request"
        request = frame.value
        assert request.verb == "POST" and request.end_body
        if request.path == "/disconnect":
            await ws.close()
            return
        if request.path == "/reset":
            await send(ServiceFrame.reset(frame.stream_id, Reset(reason="test")))
            continue
        if request.path == "/noheaders":
            continue
        if request.path == "/slow":
            await send(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=200)))
            continue
        if request.path == "/split":
            await send(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=200)))
            await send(ServiceFrame.body_chunk(frame.stream_id, BodyChunk(data=b"x" * 180000, end_body=True)), reverse=True)
            continue
        await send(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=200, body=request.body, end_body=True)))


async def main():
    async with serve(handle, "127.0.0.1", 0) as server:
        print(server.sockets[0].getsockname()[1], flush=True)
        await asyncio.Future()

asyncio.run(main())
