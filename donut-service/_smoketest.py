import torch, transformers
print("torch", torch.__version__, "| transformers", transformers.__version__)
from transformers import DonutProcessor, VisionEncoderDecoderModel
print("DonutProcessor OK, VisionEncoderDecoderModel OK")
print("token2json present:", hasattr(DonutProcessor, "token2json"))
import app
print("app import OK — routes:", [getattr(r, "path", "?") for r in app.app.routes])
