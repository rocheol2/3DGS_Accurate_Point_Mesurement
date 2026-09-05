#!/usr/bin/env python3
"""
measure_distance.py - 3DGS 측정 도구(GDAOSU 3dgs_measurement_tool)에서 내보낸
Points CSV/GeoJSON 또는 Polylines CSV 로부터 3D 거리(m)를 계산한다.

  points CSV 헤더  : id,lon,lat,alt,accuracy        (Points 탭 → Export → CSV)
  polyline CSV 헤더: geometry_id,point_order,lon,lat,alt (Polylines 탭 → Export → CSV)
  GeoJSON          : Point / LineString FeatureCollection

계산: (lon,lat,alt) → WGS84 ECEF(m) → 유클리드 거리.  Cesium 이 사용하는 것과 같은 타원체.

예)
  python measure_distance.py points.csv --all                  # 모든 점 쌍
  python measure_distance.py points.csv --pairs 1-2 3-4        # 지정 쌍
  python measure_distance.py polylines.csv --chain             # 폴리라인 구간별·누적 길이
  python measure_distance.py points.csv --pairs 1-2 --scale 1.0123   # 사후 축척 보정
  python measure_distance.py points.csv --calibrate 1 2 12.50  # 1-2 의 실제 길이가 12.50 m 일 때 축척계수 계산
"""
import argparse, csv, itertools, json, math, sys

A = 6378137.0; F = 1 / 298.257223563; E2 = F * (2 - F)

def ecef(lon, lat, h):
    la, lo = math.radians(lat), math.radians(lon)
    N = A / math.sqrt(1 - E2 * math.sin(la) ** 2)
    return ((N + h) * math.cos(la) * math.cos(lo), (N + h) * math.cos(la) * math.sin(lo), (N * (1 - E2) + h) * math.sin(la))

def dist(p, q):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(p, q)))

def load(path):
    """returns points: {id: (lon,lat,alt,acc)}, lines: {gid: [(lon,lat,alt), ...]}"""
    points, lines = {}, {}
    if path.lower().endswith(('.geojson', '.json')):
        gj = json.load(open(path, encoding='utf-8'))
        for i, f in enumerate(gj.get('features', [])):
            g = f.get('geometry', {}); pr = f.get('properties', {}) or {}
            if g.get('type') == 'Point':
                c = g['coordinates']; pid = str(pr.get('id', i + 1))
                points[pid] = (float(c[0]), float(c[1]), float(c[2]) if len(c) > 2 else 0.0, float(pr.get('accuracy', 'nan')))
            elif g.get('type') == 'LineString':
                lines[str(pr.get('id', i + 1))] = [(float(c[0]), float(c[1]), float(c[2]) if len(c) > 2 else 0.0) for c in g['coordinates']]
            elif g.get('type') == 'Polygon':
                lines[str(pr.get('id', i + 1))] = [(float(c[0]), float(c[1]), float(c[2]) if len(c) > 2 else 0.0) for c in g['coordinates'][0]]
        return points, lines
    with open(path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit('빈 CSV')
    h = {k.strip().lower(): k for k in rows[0].keys()}
    if 'geometry_id' in h:
        for r in rows:
            lines.setdefault(r[h['geometry_id']], []).append((int(r[h['point_order']]), float(r[h['lon']]), float(r[h['lat']]), float(r[h['alt']])))
        lines = {k: [p[1:] for p in sorted(v)] for k, v in lines.items()}
    else:
        for i, r in enumerate(rows):
            pid = r[h['id']] if 'id' in h else str(i + 1)
            acc = float(r[h['accuracy']]) if 'accuracy' in h and r[h['accuracy']] not in ('', None) else float('nan')
            points[pid] = (float(r[h['lon']]), float(r[h['lat']]), float(r[h['alt']]), acc)
    return points, lines

def fmt_sigma(a, b):
    if math.isnan(a) or math.isnan(b):
        return '   -  '
    return f'{math.sqrt(a * a + b * b):6.3f}'

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file')
    ap.add_argument('--pairs', nargs='*', help='예: 1-2 3-4  (Points 목록의 id)')
    ap.add_argument('--all', action='store_true', help='모든 점 쌍 거리')
    ap.add_argument('--chain', action='store_true', help='폴리라인 구간별·누적 길이 (Points CSV 이면 id 순서대로 연결)')
    ap.add_argument('--scale', type=float, default=1.0, help='사후 축척계수 (모델을 미터로 미리 변환했다면 1.0)')
    ap.add_argument('--calibrate', nargs=3, metavar=('ID_A', 'ID_B', 'TRUE_M'), help='실측 거리로 축척계수 계산')
    a = ap.parse_args()
    points, lines = load(a.file)
    P = {k: ecef(*v[:3]) for k, v in points.items()}
    print(f'점 {len(points)}개, 폴리라인 {len(lines)}개 로드 | 축척계수 {a.scale}')
    if a.calibrate:
        i, j, true_m = a.calibrate[0], a.calibrate[1], float(a.calibrate[2])
        d = dist(P[i], P[j])
        print(f'\n[축척 보정] {i}-{j} 측정 {d:.4f} m, 실측 {true_m:.4f} m → 축척계수 s = {true_m / d:.6f}')
        print('  이후 거리에 --scale 값으로 넣거나, gs_ply_georef.py apply --scale 로 PLY 자체를 다시 스케일하세요.')
        return
    if a.pairs or a.all:
        pairs = [tuple(p.split('-', 1)) for p in a.pairs] if a.pairs else list(itertools.combinations(points.keys(), 2))
        print('\n  A   -  B   |  거리(m)   | σ_A   σ_B  (도구 σ, m) | √(σA²+σB²)')
        for i, j in pairs:
            if i not in P or j not in P:
                print(f'  {i}-{j}: id 없음'); continue
            d = dist(P[i], P[j]) * a.scale
            print(f'  {i:>3} - {j:<3} | {d:9.4f} | {points[i][3]:5.3f} {points[j][3]:5.3f}        | {fmt_sigma(points[i][3], points[j][3])}')
    if a.chain:
        chains = dict(lines)
        if not chains and points:
            chains = {'points(id 순)': [points[k][:3] for k in sorted(points, key=lambda x: (len(x), x))]}
        for gid, coords in chains.items():
            E = [ecef(*c) for c in coords]
            print(f'\n[{gid}] 정점 {len(E)}개')
            total = 0.0
            for k in range(len(E) - 1):
                d = dist(E[k], E[k + 1]) * a.scale; total += d
                print(f'  구간 {k + 1:>2}: {d:9.4f} m   누적 {total:9.4f} m')
            if len(E) > 2:
                print(f'  총 길이 {total:.4f} m' + (f' (폐합 시 +{dist(E[-1], E[0]) * a.scale:.4f} m)' if E[0] != E[-1] else ''))
    if not (a.pairs or a.all or a.chain):
        print('옵션을 지정하세요: --all | --pairs 1-2 | --chain | --calibrate A B TRUE_M')

if __name__ == '__main__':
    main()
