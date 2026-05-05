import json
import os
import re
import sys

CRS = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
OUT_DIR = "fix"


def reverse_rings(geom):
    """Reverse every ring in a geometry to flip winding direction (CCW <-> CW)."""
    geom_type = geom.get("type")
    coords = geom.get("coordinates")
    if coords is None:
        return

    if geom_type == "Polygon":
        geom["coordinates"] = [list(reversed(ring)) for ring in coords]
    elif geom_type == "MultiPolygon":
        geom["coordinates"] = [
            [list(reversed(ring)) for ring in polygon] for polygon in coords
        ]
    elif geom_type == "GeometryCollection":
        for g in geom.get("geometries", []):
            reverse_rings(g)


def fix_geojson(input_path):
    if os.path.getsize(input_path) == 0:
        print(f"Error: {input_path} is empty (0 bytes). Re-export it from geojson.io.")
        return None

    with open(input_path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error: {input_path} is not valid JSON: {e}")
            return None

    # 1. Reverse all ring directions (CCW -> CW)
    for feat in data.get("features", []):
        geom = feat.get("geometry")
        if geom:
            reverse_rings(geom)

    # 2. Inject CRS
    data["crs"] = CRS

    # 3. Inject name from filename (e.g. europe_1700.geojson -> world_1700)
    basename = os.path.basename(input_path)
    match = re.search(r"(\d{4})", basename)
    year = match.group(1) if match else "unknown"
    data["name"] = f"world_{year}"

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, basename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    print(f"Fixed: {input_path} -> {out_path}")
    return out_path


def main():
    if len(sys.argv) < 2:
        print("Usage: python fix_geojson.py <file.geojson> [...]")
        sys.exit(1)

    for path in sys.argv[1:]:
        if not os.path.exists(path):
            print(f"Skipping (not found): {path}")
            continue
        fix_geojson(path)


if __name__ == "__main__":
    main()
