"""RGB-only successor to the project's original pyrealsense2 CameraBridge.

Output protocol: unsigned big-endian JPEG byte length, followed by JPEG bytes.
No depth, skeleton inference, recording or cloud connection runs here.
"""
import io
import json
import struct
import sys
import numpy as np
from PIL import Image
import pyrealsense2 as rs

pipeline = rs.pipeline()
started = False
try:
    if not list(rs.context().query_devices()):
        raise RuntimeError('没有检测到 RealSense 相机，请检查 USB 连接。')
    for width, height in [(1280, 800), (1280, 720), (640, 480)]:
        config = rs.config()
        config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, 30)
        try:
            pipeline.start(config)
            started = True
            break
        except RuntimeError:
            continue
    if not started:
        raise RuntimeError('无法启动 D455 彩色流。请关闭正在占用摄像头的软件。')
    sys.stderr.write(json.dumps({'type': 'ready', 'width': width, 'height': height, 'fps': 30}) + '\n')
    sys.stderr.flush()
    while True:
        frames = pipeline.wait_for_frames(5000)
        color = frames.get_color_frame()
        if not color:
            continue
        array = np.asanyarray(color.get_data())
        out = io.BytesIO()
        Image.fromarray(array[:, :, ::-1]).save(out, format='JPEG', quality=86)
        jpeg = out.getvalue()
        sys.stdout.buffer.write(struct.pack('>I', len(jpeg)))
        sys.stdout.buffer.write(jpeg)
        sys.stdout.buffer.flush()
except (BrokenPipeError, KeyboardInterrupt):
    pass
except Exception as error:
    sys.stderr.write(json.dumps({'type': 'error', 'message': str(error)}, ensure_ascii=True) + '\n')
    sys.stderr.flush()
    sys.exit(1)
finally:
    if started:
        pipeline.stop()
