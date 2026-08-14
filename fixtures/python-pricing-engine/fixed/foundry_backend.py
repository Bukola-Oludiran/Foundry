from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    name = "python_pricing_engine-0.0.0-py3-none-any.whl"
    destination = Path(wheel_directory) / name
    root = Path(__file__).parent
    dist_info = "python_pricing_engine-0.0.0.dist-info"
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for source in sorted((root / "pricing_engine").glob("*.py")):
            archive.write(source, f"pricing_engine/{source.name}")
        archive.writestr(f"{dist_info}/METADATA", "Metadata-Version: 2.1\nName: python-pricing-engine\nVersion: 0.0.0\nRequires-Python: >=3.11\n")
        archive.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\nGenerator: foundry-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr(f"{dist_info}/RECORD", "")
    return name
