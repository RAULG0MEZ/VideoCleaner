from pathlib import Path
from subprocess import run
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"


def lerp(left: int, right: int, amount: float) -> int:
    return round(left + (right - left) * amount)


def gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = image.load()
    start = (130, 240, 213)
    mid = (103, 194, 172)
    end = (209, 168, 78)

    for y in range(size):
        for x in range(size):
            t = (x * 0.42 + y * 0.58) / max(1, size - 1)
            if t < 0.56:
                local = t / 0.56
                color = tuple(lerp(start[i], mid[i], local) for i in range(3))
            else:
                local = (t - 0.56) / 0.44
                color = tuple(lerp(mid[i], end[i], local) for i in range(3))
            pixels[x, y] = (*color, 255)

    return image


def make_icon(size: int) -> Image.Image:
    scale = size / 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    inner_radius = round(12 * scale)
    inner_box = tuple(round(value * scale) for value in (6, 6, 58, 58))
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(inner_box, radius=inner_radius, fill=255)
    image.paste(gradient(size), (0, 0), mask)

    stroke = max(2, round(4 * scale))
    ink = (7, 17, 15, 255)
    icon = ImageDraw.Draw(image)

    mic_box = tuple(round(value * scale) for value in (25, 13, 39, 38))
    icon.rounded_rectangle(mic_box, radius=round(7 * scale), outline=ink, width=stroke)
    icon.arc(
        tuple(round(value * scale) for value in (19.5, 21, 44.5, 45.5)),
        start=0,
        end=180,
        fill=ink,
        width=stroke,
    )
    icon.line(
        [tuple(round(v * scale) for v in point) for point in ((32, 42), (32, 50), (26.5, 50), (37.5, 50))],
        fill=ink,
        width=stroke,
        joint="curve",
    )

    return image


def main() -> None:
    BUILD.mkdir(exist_ok=True)
    ICONSET.mkdir(exist_ok=True)

    base = make_icon(1024)
    base.save(BUILD / "icon.png")
    base.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }

    for filename, target_size in sizes.items():
        base.resize((target_size, target_size), Image.Resampling.LANCZOS).save(ICONSET / filename)

    run(["iconutil", "-c", "icns", str(ICONSET), "-o", str(BUILD / "icon.icns")], check=True)
    print(f"Generated {BUILD / 'icon.icns'}")


if __name__ == "__main__":
    main()
