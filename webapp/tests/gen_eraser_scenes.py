#!/usr/bin/env python3
"""지우개 테스트용 합성 장면 (test_eraser.js, test_bigcoord.js 가 사용). 먼저 gen_test_ply.py 로 cube_m.ply 를 만든 뒤 실행.
  cube_floaters.ply : cube_m + 반투명 큰 잡티 6개(맨 뒤 6행, 크기 0.4 m, (1,1,3.2) 근처)
  cube_big.ply      : cube_m 을 국가좌표처럼 큰 좌표(285889.063, 121060.398, 40)로 옮긴 것
  layers.ply        : 불투명한 평면 4겹 (z = 0, 0.5, 1.0, 1.5 m, 각 6000개 · 행 순서 = 아래 겹부터) — 층 수 선택 검증용
"""
import numpy as np
NAMES = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
SH0 = 0.28209479177387814
def read(path):
    b = open(path, 'rb').read(); i = b.index(b'end_header\n') + 11
    return np.frombuffer(b[i:], '<f4').reshape(-1, len(NAMES)).copy()
def write(path, data, comments):
    hdr = ['ply', 'format binary_little_endian 1.0'] + ['comment ' + c for c in comments] + [f'element vertex {len(data)}'] + [f'property float {n}' for n in NAMES] + ['end_header']
    with open(path, 'wb') as f:
        f.write(('\n'.join(hdr) + '\n').encode()); data.astype('<f4').tofile(f)
def rows(P, color, sigma, logit):
    n = len(P); S = np.tile(np.log(np.broadcast_to(np.asarray(sigma, float), (3,))), (n, 1))
    return np.hstack([P, np.zeros((n, 3)), np.tile((np.asarray(color) - 0.5) / SH0, (n, 1)), np.full((n, 1), logit), S, np.tile([1.0, 0, 0, 0], (n, 1))])
COMM = ['units: meters', 'up axis: z', 'synthetic test cube edge 2.000 m']
cube = read('cube_m.ply')
FLO = np.array([[1.102, 0.8722, 3.2209], [0.9716, 0.9774, 3.1892], [0.899, 0.9884, 3.1567], [1.1661, 1.0113, 3.1824], [0.9859, 0.9666, 3.1472], [0.9805, 1.0241, 3.1881]])
write('cube_floaters.ply', np.vstack([cube, rows(FLO, [0.4, 0.7, 1.0], 0.4, 0.0)]), COMM)
big = cube.astype(np.float64); big[:, :3] += [285889.063, 121060.398, 40.0]; write('cube_big.ply', big, COMM)
rng = np.random.default_rng(7); L = []
for k, (z, col) in enumerate(zip([0.0, 0.5, 1.0, 1.5], [[0.5, 0.5, 0.55], [0.2, 0.6, 0.9], [0.3, 0.8, 0.3], [0.9, 0.5, 0.2]])):
    xy = rng.uniform(0, 3, size=(6000, 2)); L.append(rows(np.c_[xy, np.full(6000, z)], col, [0.03, 0.03, 0.002], 6.0))
write('layers.ply', np.vstack(L), ['units: meters', 'up axis: z', 'synthetic 4 opaque layers z=0,0.5,1.0,1.5'])
print('wrote cube_floaters.ply', len(cube) + 6, '| cube_big.ply', len(cube), '| layers.ply', 24000)
