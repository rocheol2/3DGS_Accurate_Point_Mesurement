#!/usr/bin/env python3
"""합성 3DGS PLY 생성: 한 변 2.000 m 정육면체 모서리(와이어프레임) + 바닥판.
꼭짓점 좌표가 정확히 알려져 있어 측정 정확도 검증에 사용.
  cube.ply    : 메타데이터 없음 (축척 미확인 케이스)
  cube_m.ply  : 헤더에 'units: meters', 'up axis: z' 주석 (축척 확인 케이스)
좌표계: Z-up. 정육면체 꼭짓점 (0,0,0)~(2,2,2). 바닥판 z=0, 6x6 m.
"""
import numpy as np, sys
rng = np.random.default_rng(0)
def gaussians_on_segment(a, b, n, color, sigma=0.012):
    t = np.linspace(0, 1, n)
    p = a[None, :] * (1 - t[:, None]) + b[None, :] * t[:, None]
    return p, np.tile(color, (n, 1)), np.full((n, 3), np.log(sigma))
P, C, S = [], [], []
V = np.array([[x, y, z] for x in (0, 2) for y in (0, 2) for z in (0, 2)], float)
edges = [(i, j) for i in range(8) for j in range(i + 1, 8) if np.sum(np.abs(V[i] - V[j]) > 0) == 1]
for i, j in edges:
    p, c, s = gaussians_on_segment(V[i], V[j], 400, np.array([0.9, 0.2, 0.1]))
    P.append(p); C.append(c); S.append(s)
# 꼭짓점 마커: 밝은 노란색, 조금 큰 구
for v in V:
    P.append(v[None, :] + rng.normal(scale=0.003, size=(40, 3))); C.append(np.tile([1.0, 1.0, 0.2], (40, 1))); S.append(np.full((40, 3), np.log(0.02)))
# 바닥판 (회색), z=0, -2..4 범위
n = 40000
xy = rng.uniform(-2, 4, size=(n, 2)); P.append(np.c_[xy, np.zeros(n)]); C.append(np.tile([0.45, 0.45, 0.5], (n, 1))); S.append(np.tile([np.log(0.05), np.log(0.05), np.log(0.002)], (n, 1)))
P = np.vstack(P); C = np.vstack(C); S = np.vstack(S); N = len(P)
SH0 = 0.28209479177387814
f_dc = (C - 0.5) / SH0
opacity_logit = np.full((N, 1), 6.0, np.float32)  # sigmoid(6)=0.9975
rot = np.tile([1.0, 0.0, 0.0, 0.0], (N, 1))
names = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
data = np.hstack([P, np.zeros((N, 3)), f_dc, opacity_logit, S, rot]).astype('<f4')
def write(path, comments):
    hdr = ['ply', 'format binary_little_endian 1.0'] + ['comment ' + c for c in comments] + [f'element vertex {N}'] + [f'property float {n}' for n in names] + ['end_header']
    with open(path, 'wb') as f:
        f.write(('\n'.join(hdr) + '\n').encode()); data.tofile(f)
write('cube.ply', [])
write('cube_m.ply', ['units: meters', 'up axis: z', 'synthetic test cube edge 2.000 m'])
print('wrote cube.ply / cube_m.ply, splats:', N, 'edge length 2.000 m, vertices:', V.tolist())
