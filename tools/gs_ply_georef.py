#!/usr/bin/env python3
"""
gs_ply_georef.py - 3DGS PLY 에 유사변환(축척·회전·이동)을 적용해
                   미터 단위 / Z-up(ENU) 로컬 좌표계 PLY 로 만드는 도구.

  info      PLY 헤더·개수·범위 요약
  from-gps  COLMAP images.bin + 원본 사진(EXIF/XMP GPS) 로 유사변환을 추정해 PLY 에 적용
  apply     이미 아는 축척/회전/이동을 직접 적용 (예: GCP georeference_summary.txt 값)

가우시안 속성 처리
  x,y,z         p' = s·R·p + t  (float64 계산 후 float32 저장)
  scale_0..2    log-scale 이므로 ln(s) 를 더함
  rot_0..3      (w,x,y,z) 쿼터니언, q' = q_R ⊗ q
  nx,ny,nz      회전
  f_rest_*      SH 계수를 회전 (deg 1~3, 3DGS sh_utils 기저 기준). --no-sh-rotation 으로 생략 가능
  opacity,f_dc  변경 없음

출력 PLY 헤더에는 "up axis: z", "units: meters" 주석을 넣어
3dgs-ply-3dtiles-converter 가 Z-up 소스로 인식하게 한다.
(주석에 'camera', 'colmap', 'y down' 같은 단어를 넣으면 변환기가 카메라 좌표계로 오인하므로 넣지 않는다)
"""
import argparse, glob, json, math, os, re, struct, sys
import numpy as np

# ----------------------------------------------------------------------------- PLY IO
def read_ply(path):
    with open(path, 'rb') as f:
        header = b''
        while not header.endswith(b'end_header\n'):
            line = f.readline()
            if not line:
                raise ValueError('PLY 헤더를 읽을 수 없습니다')
            header += line
        text = header.decode('ascii', 'replace')
        if 'binary_little_endian' not in text:
            raise ValueError('binary_little_endian PLY 만 지원합니다')
        elements = re.findall(r'element (\w+) (\d+)', text)
        if len(elements) != 1 or elements[0][0] != 'vertex':
            raise ValueError(f'vertex 단일 element PLY 만 지원합니다: {elements}')
        n = int(elements[0][1])
        props = re.findall(r'property (\w+) (\w+)', text)
        bad = [p for p in props if p[0] not in ('float', 'float32')]
        if bad:
            raise ValueError(f'float32 속성만 지원합니다: {bad[:3]}')
        names = [nm for _, nm in props]
        comments = [l[len('comment '):] for l in text.splitlines() if l.startswith('comment ')]
        data = np.fromfile(f, dtype='<f4', count=n * len(names))
        if data.size != n * len(names):
            raise ValueError('PLY 데이터 길이가 헤더와 다릅니다 (파일 손상?)')
        data = data.reshape(n, len(names))
    return names, data, comments

def write_ply(path, names, data, comments):
    lines = ['ply', 'format binary_little_endian 1.0']
    for c in comments:
        lines.append('comment ' + c.replace('\n', ' '))
    lines.append(f'element vertex {data.shape[0]}')
    lines += [f'property float {nm}' for nm in names]
    lines.append('end_header')
    with open(path, 'wb') as f:
        f.write(('\n'.join(lines) + '\n').encode('ascii'))
        np.ascontiguousarray(data, dtype='<f4').tofile(f)

def check_3dgs(names):
    need = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    missing = [n for n in need if n not in names]
    if missing:
        hint = ''
        if 'scale_2' in missing and 'scale_1' in names:
            hint = ' (2DGS 원본 PLY 입니다. tools/convert_2dgs_to_3dgs_ply.py 로 만든 point_cloud_3dgs.ply 를 사용하세요)'
        raise ValueError(f'3DGS PLY 필수 속성 누락: {missing}{hint}')

# ----------------------------------------------------------------------------- rotation utils
def quat_from_rotmat(R):
    m = R
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        S = math.sqrt(tr + 1.0) * 2
        w = 0.25 * S; x = (m[2, 1] - m[1, 2]) / S; y = (m[0, 2] - m[2, 0]) / S; z = (m[1, 0] - m[0, 1]) / S
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        S = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / S; x = 0.25 * S; y = (m[0, 1] + m[1, 0]) / S; z = (m[0, 2] + m[2, 0]) / S
    elif m[1, 1] > m[2, 2]:
        S = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / S; x = (m[0, 1] + m[1, 0]) / S; y = 0.25 * S; z = (m[1, 2] + m[2, 1]) / S
    else:
        S = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / S; x = (m[0, 2] + m[2, 0]) / S; y = (m[1, 2] + m[2, 1]) / S; z = 0.25 * S
    q = np.array([w, x, y, z]); return q / np.linalg.norm(q)

def quat_mul(a, b):
    """Hamilton product, (w,x,y,z). a: (4,), b: (N,4)"""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([w1*w2 - x1*x2 - y1*y2 - z1*z2,
                     w1*x2 + x1*w2 + y1*z2 - z1*y2,
                     w1*y2 - x1*z2 + y1*w2 + z1*x2,
                     w1*z2 + x1*y2 - y1*x2 + z1*w2], 1)

def qvec2rotmat(q):
    w, x, y, z = q
    return np.array([[1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w],
                     [2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w],
                     [2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y]])

# ----------------------------------------------------------------------------- SH rotation (3DGS sh_utils 기저)
C1 = 0.4886025119029199
C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396]
C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154,
      -0.4570457994644658, 1.445305721320277, -0.5900435899266435]

def sh_basis_rest(d, deg):
    x, y, z = d[:, 0], d[:, 1], d[:, 2]
    cols = []
    if deg >= 1:
        cols += [-C1*y, C1*z, -C1*x]
    if deg >= 2:
        xx, yy, zz = x*x, y*y, z*z; xy, yz, xz = x*y, y*z, x*z
        cols += [C2[0]*xy, C2[1]*yz, C2[2]*(2*zz-xx-yy), C2[3]*xz, C2[4]*(xx-yy)]
    if deg >= 3:
        cols += [C3[0]*y*(3*xx-yy), C3[1]*xy*z, C3[2]*y*(4*zz-xx-yy), C3[3]*z*(2*zz-3*xx-3*yy),
                 C3[4]*x*(4*zz-xx-yy), C3[5]*z*(xx-yy), C3[6]*x*(xx-3*yy)]
    return np.stack(cols, 1)

def sh_rotation_matrix(R, deg):
    """c' = D c  가 되도록 하는 D (K×K).  b(e)·c' = b(Rᵀe)·c  ∀e"""
    rng = np.random.default_rng(0)
    d = rng.normal(size=(600, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
    B = sh_basis_rest(d, deg)
    Brot = sh_basis_rest((R.T @ d.T).T, deg)
    D, *_ = np.linalg.lstsq(B, Brot, rcond=None)
    fit_err = np.abs(B @ D - Brot).max()
    orth_err = np.abs(D @ D.T - np.eye(D.shape[0])).max()
    if fit_err > 1e-8 or orth_err > 1e-6:
        raise RuntimeError(f'SH 회전 행렬 검증 실패 fit={fit_err:.2e} orth={orth_err:.2e}')
    return D

# ----------------------------------------------------------------------------- apply similarity
def apply_similarity(names, data, s, R, t, rotate_sh=True, log=print):
    idx = {n: i for i, n in enumerate(names)}
    R = np.asarray(R, dtype=np.float64); t = np.asarray(t, dtype=np.float64).reshape(3)
    if abs(np.linalg.det(R) - 1) > 1e-6 or np.abs(R @ R.T - np.eye(3)).max() > 1e-6:
        raise ValueError('R 은 정규직교 회전행렬(det=+1)이어야 합니다')
    xyz = data[:, [idx['x'], idx['y'], idx['z']]].astype(np.float64)
    xyz = (s * (R @ xyz.T)).T + t
    data[:, idx['x']] = xyz[:, 0]; data[:, idx['y']] = xyz[:, 1]; data[:, idx['z']] = xyz[:, 2]
    if all(k in idx for k in ('nx', 'ny', 'nz')):
        nrm = data[:, [idx['nx'], idx['ny'], idx['nz']]].astype(np.float64)
        nrm = (R @ nrm.T).T
        data[:, idx['nx']] = nrm[:, 0]; data[:, idx['ny']] = nrm[:, 1]; data[:, idx['nz']] = nrm[:, 2]
    for k in ('scale_0', 'scale_1', 'scale_2'):
        data[:, idx[k]] = (data[:, idx[k]].astype(np.float64) + math.log(s)).astype(np.float32)
    q = data[:, [idx['rot_0'], idx['rot_1'], idx['rot_2'], idx['rot_3']]].astype(np.float64)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    q = quat_mul(quat_from_rotmat(R), q)
    for j, k in enumerate(('rot_0', 'rot_1', 'rot_2', 'rot_3')):
        data[:, idx[k]] = q[:, j]
    rest = sorted([n for n in names if n.startswith('f_rest_')], key=lambda n: int(n.split('_')[-1]))
    if rest and rotate_sh:
        K = len(rest) // 3
        deg = int(round(math.sqrt(K + 1) - 1))
        if (deg + 1) ** 2 - 1 != K:
            log(f'  [경고] f_rest 개수 {len(rest)} 가 SH 차수와 맞지 않아 SH 회전을 생략합니다')
        else:
            D = sh_rotation_matrix(R, deg)
            cols = [idx[n] for n in rest]
            f = data[:, cols].reshape(-1, 3, K)                 # (N, 3ch, K)  index = ch*K + k
            f = (f.astype(np.float64) @ D.T).astype(np.float32)
            data[:, cols] = f.reshape(-1, 3 * K)
            log(f'  SH 계수 회전 적용 (deg={deg}, K={K})')
    elif rest:
        log('  SH 계수 회전 생략 (--no-sh-rotation)')
    return data

# ----------------------------------------------------------------------------- geodesy
A_WGS = 6378137.0; F_WGS = 1 / 298.257223563; E2_WGS = F_WGS * (2 - F_WGS)

def geodetic_to_ecef(lat, lon, h):
    lat, lon = np.radians(lat), np.radians(lon)
    N = A_WGS / np.sqrt(1 - E2_WGS * np.sin(lat) ** 2)
    return np.stack([(N + h) * np.cos(lat) * np.cos(lon), (N + h) * np.cos(lat) * np.sin(lon),
                     (N * (1 - E2_WGS) + h) * np.sin(lat)], -1)

def enu_matrix(lat0, lon0):
    la, lo = math.radians(lat0), math.radians(lon0)
    return np.array([[-math.sin(lo), math.cos(lo), 0],
                     [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)],
                     [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)]])

# ----------------------------------------------------------------------------- COLMAP + EXIF
def read_colmap_images(path):
    """{basename: camera_center(3,)} - images.bin 또는 images.txt"""
    centers = {}
    if path.endswith('.txt'):
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith('#')]
        for i in range(0, len(lines), 2):
            p = lines[i].split()
            q = np.array(list(map(float, p[1:5]))); t = np.array(list(map(float, p[5:8]))); name = p[9]
            centers[os.path.basename(name)] = -qvec2rotmat(q).T @ t
        return centers
    with open(path, 'rb') as f:
        n = struct.unpack('<Q', f.read(8))[0]
        for _ in range(n):
            f.read(4)
            q = np.array(struct.unpack('<4d', f.read(32))); t = np.array(struct.unpack('<3d', f.read(24)))
            f.read(4)
            name = b''
            while True:
                c = f.read(1)
                if c == b'\x00' or not c:
                    break
                name += c
            npts = struct.unpack('<Q', f.read(8))[0]; f.read(24 * npts)
            centers[os.path.basename(name.decode())] = -qvec2rotmat(q).T @ t
    return centers

def read_photo_gps(path, alt_mode):
    from PIL import Image
    from PIL.ExifTags import GPSTAGS
    im = Image.open(path); ex = im._getexif() or {}
    g = ex.get(34853)
    if not g:
        return None
    g = {GPSTAGS.get(k, k): v for k, v in g.items()}
    def dms(v): return float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
    try:
        lat = dms(g['GPSLatitude']) * (1 if g.get('GPSLatitudeRef', 'N') == 'N' else -1)
        lon = dms(g['GPSLongitude']) * (1 if g.get('GPSLongitudeRef', 'E') == 'E' else -1)
    except KeyError:
        return None
    exif_alt = None
    if 'GPSAltitude' in g:
        exif_alt = float(g['GPSAltitude']) * (-1 if g.get('GPSAltitudeRef', b'\x00') in (b'\x01', 1) else 1)
    with open(path, 'rb') as fh:
        raw = fh.read(3_000_000)
    def xmp(tag):
        m = re.search(rb'drone-dji:' + tag.encode() + rb'="([+-]?[\d.]+)"', raw) or \
            re.search(rb'<drone-dji:' + tag.encode() + rb'>([+-]?[\d.]+)<', raw)
        return float(m.group(1)) if m else None
    rel, ab = xmp('RelativeAltitude'), xmp('AbsoluteAltitude')
    alt = {'xmp-relative': rel, 'xmp-absolute': ab, 'exif': exif_alt}.get(alt_mode)
    if alt is None:
        alt = rel if rel is not None else (exif_alt if exif_alt is not None else ab)
    return lat, lon, alt, rel, ab, exif_alt

def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0); S, D = src - mu_s, dst - mu_d
    cov = D.T @ S / len(src); U, Sg, Vt = np.linalg.svd(cov)
    d = np.sign(np.linalg.det(U) * np.linalg.det(Vt)) or 1.0
    Dm = np.diag([1, 1, d]); R = U @ Dm @ Vt
    s = (Sg * np.diag(Dm)).sum() / ((S ** 2).sum() / len(src)); t = mu_d - s * R @ mu_s
    return s, R, t

def ground_level(xyz, center_xy, radius, pct=2.0):
    d = np.linalg.norm(xyz[:, :2] - center_xy, axis=1)
    sel = xyz[d < radius, 2]
    return float(np.percentile(sel, pct)) if sel.size > 100 else float(np.percentile(xyz[:, 2], pct))

# ----------------------------------------------------------------------------- subcommands
def cmd_info(a):
    names, data, comments = read_ply(a.ply)
    print(f'파일: {a.ply}\n가우시안 수: {data.shape[0]:,}\n속성 {len(names)}개: {names[:6]} ... {names[-8:]}')
    print('주석:', comments if comments else '(없음)')
    xyz = data[:, :3]
    lo, hi = np.percentile(xyz, 1, axis=0), np.percentile(xyz, 99, axis=0)
    print('위치 1~99% 범위 (단위: 모델 단위):', np.round(hi - lo, 2), ' 중앙값:', np.round(np.median(xyz, 0), 2))
    idx = {n: i for i, n in enumerate(names)}
    if 'scale_0' in idx:
        sc = data[:, [idx['scale_0'], idx['scale_1'], idx.get('scale_2', idx['scale_1'])]]
        print('exp(scale) 중앙값:', np.round(np.exp(np.median(sc, 0)), 5))
    rest = [n for n in names if n.startswith('f_rest_')]
    print('SH 차수:', int(round(math.sqrt(len(rest) // 3 + 1) - 1)) if rest else 0)

def finish(a, names, data, comments_in, s, R, t, meta, log=print):
    out_comments = [c for c in comments_in if not re.search(r'camera|colmap|y[-_ ]?down|z[-_ ]?forward', c, re.I)]
    out_comments += ['up axis: z', 'units: meters',
                     'generated by gs_ply_georef.py; similarity transform applied to sfm local frame',
                     f'scale {s:.8f}']
    write_ply(a.out, names, data, out_comments)
    meta.update({'output_ply': os.path.abspath(a.out), 'scale': float(s), 'rotation': np.asarray(R).tolist(),
                 'translation': np.asarray(t).tolist(), 'sh_rotated': not a.no_sh_rotation,
                 'ply_axes': 'x=East, y=North, z=Up (meters)'})
    side = a.out + '.json'
    with open(side, 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    log(f'\n저장: {a.out}\n메타: {side}')

def cmd_apply(a):
    names, data, comments = read_ply(a.ply); check_3dgs(names)
    if a.rotation and a.rotation_2d:
        sys.exit('--rotation 과 --rotation-2d 는 동시에 줄 수 없습니다')
    R = np.eye(3)
    if a.rotation:
        R = np.array(a.rotation, dtype=float).reshape(3, 3)
    elif a.rotation_2d:
        R[:2, :2] = np.array(a.rotation_2d, dtype=float).reshape(2, 2)
    t = np.array(a.translation, dtype=float) if a.translation else np.zeros(3)
    print(f'가우시안 {data.shape[0]:,}개, 축척 {a.scale}, 회전\n{np.round(R, 6)}\n이동 {t}')
    data = apply_similarity(names, data, a.scale, R, t, rotate_sh=not a.no_sh_rotation)
    xyz = data[:, :3].astype(np.float64)
    origin = np.zeros(3)
    if a.local_origin == 'auto':
        med = np.median(xyz, 0)
        if np.abs(med).max() > 5000:
            origin = np.round(med, 0)
    elif a.local_origin:
        origin = np.array(a.local_origin, dtype=float)
    if np.any(origin != 0):
        xyz -= origin; data[:, 0] = xyz[:, 0]; data[:, 1] = xyz[:, 1]; data[:, 2] = xyz[:, 2]
        print(f'로컬 원점 {origin} 을 빼서 float32 정밀도를 보호했습니다 (실좌표 = PLY좌표 + 원점)')
    meta = {'mode': 'apply', 'input_ply': os.path.abspath(a.ply), 'local_origin_subtracted': origin.tolist(),
            'note': '실좌표 = PLY좌표 + local_origin_subtracted'}
    finish(a, names, data, comments, a.scale, R, t - origin, meta)

def cmd_from_gps(a):
    names, data, comments = read_ply(a.ply); check_3dgs(names)
    print(f'PLY 가우시안 {data.shape[0]:,}개')
    centers = read_colmap_images(a.images)
    print(f'COLMAP 등록 이미지 {len(centers)}장')
    photos = {}
    for p in glob.glob(os.path.join(a.photos, '**', '*'), recursive=True):
        if p.lower().endswith(('.jpg', '.jpeg', '.dng', '.png')):
            photos[os.path.basename(p)] = p
    src, dst_llh, used, alt_info = [], [], [], {'rel': 0, 'abs': 0, 'exif': 0}
    for base, c in centers.items():
        p = photos.get(base) or photos.get(os.path.splitext(base)[0] + '.JPG')
        if not p:
            continue
        g = read_photo_gps(p, a.alt)
        if g is None or g[2] is None:
            continue
        lat, lon, alt, rel, ab, exif_alt = g
        alt_info['rel'] += rel is not None; alt_info['abs'] += ab is not None; alt_info['exif'] += exif_alt is not None
        src.append(c); dst_llh.append((lat, lon, alt)); used.append(base)
    if len(src) < 6:
        sys.exit(f'GPS 매칭 이미지가 {len(src)}장 뿐입니다 (최소 6장). --photos 경로/파일명을 확인하세요')
    src = np.array(src); dst_llh = np.array(dst_llh)
    print(f'GPS 매칭 {len(src)}장 | 고도 소스: {a.alt} (RelativeAltitude {alt_info["rel"]}, AbsoluteAltitude {alt_info["abs"]}, EXIF {alt_info["exif"]})')
    lat0, lon0 = dst_llh[:, 0].mean(), dst_llh[:, 1].mean()
    ecef = geodetic_to_ecef(dst_llh[:, 0], dst_llh[:, 1], dst_llh[:, 2])
    ecef0 = geodetic_to_ecef(lat0, lon0, dst_llh[:, 2].mean())
    M = enu_matrix(lat0, lon0)
    enu = (M @ (ecef - ecef0).T).T           # 원점: 평균 위치, U=0 은 평균 촬영고도
    print('GPS ENU 범위 (m):', np.round(enu.max(0) - enu.min(0), 1), '| 촬영 고도 범위: %.1f ~ %.1f' % (dst_llh[:, 2].min(), dst_llh[:, 2].max()))
    print('COLMAP 카메라 범위 (모델단위):', np.round(src.max(0) - src.min(0), 2))
    s, R, t = umeyama(src, enu)
    res = enu - (s * (R @ src.T).T + t)
    err = np.linalg.norm(res, axis=1)
    print(f'1차 적합: 축척 {s:.4f} m/단위, 잔차 RMS {np.sqrt((err**2).mean()):.2f} m')
    for it in range(a.iterations):
        keep = err <= np.percentile(err, a.keep * 100)
        s, R, t = umeyama(src[keep], enu[keep])
        res = enu - (s * (R @ src.T).T + t); err = np.linalg.norm(res, axis=1)
        rms_keep = np.sqrt((err[keep] ** 2).mean())
    print(f'강건 적합(상위 {a.keep*100:.0f}% 유지, {a.iterations}회): 축척 {s:.4f} m/단위, 잔차 RMS {rms_keep:.2f} m, 사용 {keep.sum()}장')
    print('  축별 잔차 RMS (E,N,U) m:', np.round(np.sqrt((res[keep] ** 2).mean(0)), 2))
    up_in_src = R.T @ np.array([0, 0, 1.0])
    print('  원본 좌표계에서의 위(Up) 방향:', np.round(up_in_src, 3),
          f'(기울기 {math.degrees(math.acos(abs(up_in_src[1]))):.1f}° vs -Y축)' if abs(up_in_src[1]) > abs(up_in_src[2]) else '')
    print('  축척 상대 불확도(대략): %.1f %%' % (100 * rms_keep / max(np.ptp(enu[:, :2], axis=0).mean(), 1e-6) * 2))
    print('\nPLY 변환 중 ...')
    data = apply_similarity(names, data, s, R, t, rotate_sh=not a.no_sh_rotation)
    xyz = data[:, :3].astype(np.float64)
    cam_enu = s * (R @ src.T).T + t
    center_xy = cam_enu[:, :2].mean(0); radius = np.ptp(cam_enu[:, :2], axis=0).max() / 2 + 10
    g_u = ground_level(xyz, center_xy, radius)
    h_rec = round(-g_u + a.ground_clearance, 1)
    print(f'지면(2퍼센타일) 높이 U ≈ {g_u:.1f} m → 권장 --coordinate 높이 {h_rec} m (지면이 타원체 위 {a.ground_clearance} m 에 오도록)')
    meta = {'mode': 'from-gps', 'input_ply': os.path.abspath(a.ply), 'images': os.path.abspath(a.images),
            'photos_dir': os.path.abspath(a.photos), 'n_gps_used': int(keep.sum()), 'residual_rms_m': float(rms_keep),
            'origin_lat': float(lat0), 'origin_lon': float(lon0), 'origin_note': 'ENU 원점 = 사용 사진 GPS 평균 위치, U=0 = 평균 촬영고도',
            'ground_u_m': g_u, 'recommended_coordinate': [round(lat0, 8), round(lon0, 8), h_rec],
            'converter_command': f'3dgs-ply-3dtiles-converter "{os.path.abspath(a.out)}" <출력폴더> --coordinate "[{lat0:.8f},{lon0:.8f},{h_rec}]" --no-open-inspector'}
    finish(a, names, data, comments, s, R, t, meta)
    print('\n다음 단계 (3D Tiles 변환):\n  ' + meta['converter_command'])

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('info'); p.add_argument('ply'); p.set_defaults(fn=cmd_info)
    p = sub.add_parser('apply', help='알고 있는 축척/회전/이동 적용')
    p.add_argument('--ply', required=True); p.add_argument('--out', required=True)
    p.add_argument('--scale', type=float, required=True, help='m / 모델단위 (예: 9.7429)')
    p.add_argument('--rotation', type=float, nargs=9, help='3x3 회전행렬 (행 우선 9개)')
    p.add_argument('--rotation-2d', type=float, nargs=4, help='2x2 회전행렬 (XY 평면, Z 유지)')
    p.add_argument('--translation', type=float, nargs=3)
    p.add_argument('--local-origin', nargs='*', default='auto', help="'auto'(기본) 또는 x y z. 큰 좌표를 빼서 float32 보호")
    p.add_argument('--no-sh-rotation', action='store_true'); p.set_defaults(fn=cmd_apply)
    p = sub.add_parser('from-gps', help='COLMAP + 사진 GPS 로 유사변환 추정 후 적용')
    p.add_argument('--ply', required=True); p.add_argument('--out', required=True)
    p.add_argument('--images', required=True, help='COLMAP sparse/0/images.bin (또는 images.txt)')
    p.add_argument('--photos', required=True, help='EXIF GPS 가 남아있는 원본 사진 폴더 (하위폴더 포함)')
    p.add_argument('--alt', default='xmp-relative', choices=['xmp-relative', 'xmp-absolute', 'exif'],
                   help='고도 소스. DJI 는 xmp-relative(기압고도, 정밀) 권장')
    p.add_argument('--keep', type=float, default=0.85, help='강건 적합에서 유지할 비율 (기본 0.85)')
    p.add_argument('--iterations', type=int, default=2)
    p.add_argument('--ground-clearance', type=float, default=1.0, help='권장 높이 계산 시 지면을 타원체 위 몇 m 에 둘지')
    p.add_argument('--no-sh-rotation', action='store_true'); p.set_defaults(fn=cmd_from_gps)
    a = ap.parse_args()
    if getattr(a, 'local_origin', None) not in (None, 'auto') and isinstance(a.local_origin, list):
        if len(a.local_origin) == 1 and a.local_origin[0] == 'auto':
            a.local_origin = 'auto'
        elif len(a.local_origin) == 3:
            a.local_origin = [float(v) for v in a.local_origin]
        else:
            sys.exit('--local-origin 은 auto 또는 x y z 세 값')
    a.fn(a)

if __name__ == '__main__':
    main()
