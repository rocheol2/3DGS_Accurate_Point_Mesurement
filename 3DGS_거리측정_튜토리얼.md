# 내 3DGS 모델에서 거리 측정하기
## Deng & Qin (2026) "Accurate Point Measurement in 3DGS" 방법 재현 튜토리얼

작성일 2026-09-05 · 대상 환경: 이 워크스테이션(Ubuntu, TITAN RTX, conda) · 작업 폴더 `~/storage/Cesium`

> **처음이라면 [3DGS_거리측정_쉬운설명.md](3DGS_거리측정_쉬운설명.md) 부터 보세요.** 같은 절차를 용어 설명과 함께 한 동작씩 풀어 쓴 판입니다. 이 문서는 옵션·수식·실행 로그까지 담은 상세판입니다.

---

## 0. 한눈에 보기

### 논문의 방법이 하는 일
논문(arXiv 2603.24716, ISPRS 2026)은 3DGS 렌더링에서 **표면을 "찍어서" 좌표를 얻지 않습니다.** 대신

1. Cesium 위에서 3DGS(3D Tiles)를 렌더링하고,
2. 사용자가 **같은 점(대응점)을 여러 시점에서 클릭**하면 각 클릭마다 *카메라 위치 → 클릭 픽셀* 방향의 3D 광선(ray)을 만들고,
3. N개(≥2, 논문은 5개) 광선에 가장 가까운 점을 **최소제곱 공간 교회(spatial intersection)** 로 풉니다.

   광선 i: 원점 Cᵢ, 단위방향 dᵢ → (P − Cᵢ) × dᵢ = 0 → 2N×3 선형계 A x = b → x = (AᵀA)⁻¹Aᵀb
   잔차 v = Ax − b, σ̂₀² = vᵀv / (2N−3), 공분산 Q = σ̂₀²(AᵀA)⁻¹ → 오차 타원체로 표시.

4. 이렇게 얻은 점 좌표는 **미터 단위의 지구중심(ECEF) 좌표**이므로, 두 점 사이의 유클리드 거리가 곧 실제 거리입니다. (논문은 "점 측정"까지 다루고 거리·면적은 후속 과제로 남겼습니다. 이 튜토리얼에서는 측정한 점 2개로 거리를 계산하는 스크립트를 추가했습니다.)

논문 정확도: 잘 정의된 점에서 RMSE 1~2 cm, 메시 직접 측정보다 우수. 단, 이 정확도는 **모델 자체가 정확한 축척과 좌표를 가질 때** 얘기입니다. 우리 모델은 COLMAP 임의 단위이므로 "축척 부여" 단계가 핵심입니다(2단계).

### 전체 파이프라인

```
내 3DGS PLY (COLMAP 임의 단위)
   │  tools/gs_ply_georef.py  ─ 축척·회전·이동(유사변환) → 미터, Z-up
   ▼
site01_enu.ply  (미터, 동-북-위 ENU)
   │  3dgs-ply-3dtiles-converter  ─ --coordinate [위도,경도,높이] 로 지구 위에 배치
   ▼
tileset.json + tiles/*.glb  (OGC 3D Tiles, KHR_gaussian_splatting + SPZ 압축)
   │  3dgs_measurement_tool/public/models/site01/ 에 두고 Home.jsx 에 등록
   ▼
웹 도구(npm run dev → http://localhost:5173) 에서 다시점 클릭 → 점 측정 → CSV 내보내기
   │  tools/measure_distance.py
   ▼
거리(m) + 불확도
```

### 이미 이 컴퓨터에 준비된 것 (2026-09-05 검증 완료)

| 항목 | 위치 / 내용 | 상태 |
|---|---|---|
| 논문 공개 도구 | `~/storage/Cesium/3dgs_measurement_tool` (GitHub GDAOSU/3dgs_measurement_tool 클론, `npm install` 완료, CesiumJS 1.138.0) | ✅ |
| Node.js 22 | conda 환경 `cesium_measure` (`conda activate cesium_measure` 후 `node`, `npm`, `npx` 사용) | ✅ |
| PLY 변환 스크립트 | `~/storage/Cesium/tools/gs_ply_georef.py` | ✅ 단위 테스트 통과 |
| 거리 계산 스크립트 | `~/storage/Cesium/tools/measure_distance.py` | ✅ |
| 서버 실행 스크립트 | `~/storage/Cesium/tools/start_tool.sh` | ✅ |
| Site_Research_01 미터 변환 PLY | `~/storage/Cesium/data/site01/site01_enu.ply` (+ `.json` 메타) | ✅ |
| Site_Research_01 3D Tiles | `~/storage/Cesium/3dgs_measurement_tool/public/models/site01/` | ✅ (아래 3단계 결과 참고) |
| 도구에 모델 등록 | `src/pages/Home.jsx` 의 `BASE_MODELS` 에 "Site_Research_01" 추가(기본 선택) | ✅ |

즉 **Site_Research_01 모델은 바로 5단계(실행)부터 시작해도 됩니다.** 다른 모델(DS003 등)에 적용하려면 1~4단계를 그대로 반복하면 됩니다. 브라우저 안에서의 실제 렌더링·클릭은 GUI라서 제가 검증하지 못했으니, 5단계에서 문제가 있으면 10장(문제 해결)을 보세요.

---

## 1. 단계 1 — 어떤 PLY 를 쓰는가

3DGS 학습 결과 폴더에서 **`point_cloud/iteration_30000/point_cloud.ply`** 를 사용합니다.
`input.ply`, `sparse/0/points3D.ply` 는 일반 점군이라 안 됩니다(`docs/PLY_VIEWER_GUIDE.ko.md` 와 같은 규칙).

```bash
# 예: Site_Research_01 (Vanilla 3DGS, 2,551,677 가우시안, SH 3차, 604 MB)
python3 ~/storage/Cesium/tools/gs_ply_georef.py info \
  ~/storage/03_Results/Vanilla_3DGS/Site_Research_01/point_cloud/iteration_30000/point_cloud.ply
```

출력에서 확인할 것: 속성에 `opacity, scale_0~2, rot_0~3` 이 있어야 하고, "위치 1~99% 범위" 가 **모델 단위**로 찍힙니다(Site01: 67 × 33 × 56 단위 → 이 숫자가 미터가 아님을 기억).

- **2DGS 결과**는 `scale_2` 가 없어 실패합니다 → 기존 도구 `3DGS_DATA/tools/convert_2dgs_to_3dgs_ply.py` 로 만든 `point_cloud_3dgs.ply` 를 쓰세요.
- **SuGaR/FeatureGS** 는 3DGS 스키마와 같으면 그대로 됩니다.

---

## 2. 단계 2 — 축척(미터)과 수평 맞추기 ★ 가장 중요

### 왜 필요한가
- COLMAP 재구성은 **축척이 임의**입니다(Site01은 1단위 ≈ 4.2 m). 축척을 모르면 거리가 무의미합니다.
- 변환기(3D Tiles)는 PLY 좌표를 그대로 미터로 간주하고, 헤더 주석이 없으면 **"COLMAP 카메라식(Y 아래, Z 앞)"** 으로 가정해 −Y 를 위로 세웁니다. Site01 은 실제 위 방향이 −Y 에서 **23.9° 기울어져** 있어 그대로 두면 모델이 기울어진 채 지구에 놓입니다(측정 자체는 가능하지만 항법이 불편하고 지구 표면에 잘림).
- 도구는 좌표를 ECEF(m)로 출력하므로 **PLY 를 먼저 미터·Z-up 으로 만들어 두는 것**이 가장 깔끔합니다.

`gs_ply_georef.py` 는 유사변환 p′ = s·R·p + t 를 가우시안 전체 속성에 올바르게 적용합니다:
위치(x,y,z), 법선, **log-scale(+ln s)**, **쿼터니언(q′ = q_R ⊗ q)**, 그리고 **SH 계수 회전**(시점 의존 색이 회전 후에도 맞도록; 3DGS `sh_utils` 기저 기준으로 회전행렬을 수치적으로 구해 검증). 출력 헤더에는 `up axis: z`, `units: meters` 주석을 넣어 변환기가 Z-up 으로 인식하게 합니다.

### 경로 A — 드론 GPS 로 자동 추정 (`from-gps`) ← Site01 에 적용한 방법

COLMAP `images.bin` 의 카메라 위치(모델 단위)와 **원본 사진의 EXIF/XMP GPS**(위경도 + DJI 기압 상대고도)를 Umeyama 유사변환으로 맞춥니다. 축척·회전·이동이 한 번에 나옵니다.

```bash
python3 ~/storage/Cesium/tools/gs_ply_georef.py from-gps \
  --ply    ~/storage/03_Results/Vanilla_3DGS/Site_Research_01/point_cloud/iteration_30000/point_cloud.ply \
  --images ~/storage/02_Processed/Site_Research_01/3dgs_source/sparse/0/images.bin \
  --photos ~/storage/01_Raw/Photos/01_LH \
  --out    ~/storage/Cesium/data/site01/site01_enu.ply
```

주의: `--photos` 는 **EXIF 가 살아있는 원본 사진** 폴더여야 합니다. `3dgs_source/images/` 의 언디스토션 사진은 EXIF 가 지워져 있습니다(확인함). 파일명(basename)으로 매칭합니다.

실제 실행 결과(2026-09-05, 9초 소요, RAM 3.1 GB):

```
GPS 매칭 191장 | 고도 소스: xmp-relative
GPS ENU 범위 (m): [32.8 30.0 7.5] | 촬영 고도 범위: 0.8 ~ 8.3
강건 적합(상위 85% 유지): 축척 4.2015 m/단위, 잔차 RMS 0.35 m, 사용 162장
  축별 잔차 RMS (E,N,U) m: [0.20 0.26 0.12]
  원본 좌표계에서의 위(Up) 방향: [0.009 -0.914 0.405] (기울기 23.9° vs -Y축)
  축척 상대 불확도(대략): 2.2 %
지면(2퍼센타일) 높이 U ≈ -4.9 m → 권장 --coordinate 높이 5.9 m
```

해석:
- **축척 4.2015 m/단위.** 소비자용 GPS(DJI Mini 계열, RTK 없음) 잔차 0.35 m 를 33 m 폭에 맞춘 결과라 축척 불확도가 **약 1~2 %** 입니다. 10 m 거리라면 ±10~20 cm. **cm 급이 필요하면 8단계(실측 거리로 보정)를 반드시 하세요.**
- 결과 PLY 좌표계: x=동(E), y=북(N), z=위(U), 원점 = 사진 GPS 평균 위치, U=0 = 평균 촬영 고도. 메타 `site01_enu.ply.json` 에 s, R, t, 원점 위경도, 권장 `--coordinate` 가 기록됩니다.

옵션: `--alt xmp-relative|xmp-absolute|exif`(기본 xmp-relative: DJI 기압고도가 가장 정밀), `--keep 0.85`(이상치 제거 비율), `--no-sh-rotation`.

### 경로 B — GCP 변환값을 직접 적용 (`apply`) ← DS003 처럼 축척을 이미 알 때

DS003 기숙사 드론 데이터는 GCP 측량으로 `georeference_summary.txt` 에 다음이 있습니다:

```
Scale: 9.742857245006276
Rotation (2D): [[-0.99408435 -0.10861084] [0.10861084 -0.99408435]]
Translation (2D): [285889.06304338 121060.39805281]     RMSE 0.1148 m
```

**로컬 좌표로 학습한 결과**(CM002_opencv_sift_local 계열)에 적용하는 예:

```bash
python3 ~/storage/Cesium/tools/gs_ply_georef.py apply \
  --ply  <DS003 로컬좌표 학습결과>/point_cloud/iteration_30000/point_cloud.ply \
  --out  ~/storage/Cesium/data/ds003/ds003_metric.ply \
  --scale 9.742857245006276 \
  --rotation-2d -0.99408435 -0.10861084 0.10861084 -0.99408435 \
  --translation 285889.063 121060.398 0
```

- 큰 국가좌표(28만 m)를 float32 PLY 에 그대로 쓰면 정밀도가 3 cm 로 깨집니다(CMP002 보고서에서 확인한 바로 그 문제). 그래서 `apply` 는 좌표 중앙값이 5 km 를 넘으면 **자동으로 로컬 원점을 빼고**(`--local-origin auto`) 메타 JSON 에 원점을 기록합니다. 실좌표 = PLY좌표 + 원점.
- 거리만 필요하면 `--rotation-2d`/`--translation` 을 생략하고 `--scale` 만 줘도 됩니다(거리는 축척에만 의존).
- 2D 회전만 있는 이 변환은 COLMAP 모델의 Z 가 이미 위쪽이라고 가정합니다. 지구 위 배치용 `--coordinate` 는 DS003 사진 한 장의 EXIF GPS 위경도를 쓰면 충분합니다(배치 위치는 거리 정확도에 영향 없음).
- CM001(절대좌표로 학습된 결과)은 이미 미터 단위이지만 float32 정밀도 문제가 있는 모델이므로 측정용으로는 로컬 좌표 학습 결과를 권합니다.

### 경로 C — 축척을 전혀 모를 때
축척 1로 그대로 3·4단계를 진행해 도구에서 **알려진 길이**(줌자로 실측한 문 폭, GCP 두 점 사이 거리, TLS 에서 잰 길이 등)의 양 끝점을 측정하고, 8단계의 `--calibrate` 로 축척계수를 구합니다. 그 값으로 `apply --scale` 을 다시 돌리거나 거리에 사후 곱합니다.

---

## 3. 단계 3 — 3D Tiles 변환

도구(Cesium)는 PLY 를 직접 못 읽고 **KHR_gaussian_splatting 확장이 들어간 3D Tiles** 를 읽습니다. 오픈소스 npm 변환기 `3dgs-ply-3dtiles-converter`(v0.6.5, Node ≥18) 를 씁니다. 출력은 `tileset.json` + `tiles/{level}/{x}.glb`(SPZ 압축, LOD 포함) + `build_summary.json`.

```bash
source ~/miniconda3/etc/profile.d/conda.sh && conda activate cesium_measure
cd ~/storage/Cesium

npx --yes 3dgs-ply-3dtiles-converter@0.6.5 \
  ~/storage/Cesium/data/site01/site01_enu.ply \
  ~/storage/Cesium/3dgs_measurement_tool/public/models/site01 \
  --coordinate "[35.17779716,128.14690829,5.9]" \
  --no-open-inspector --memory-budget 16
```

옵션 설명
- `--coordinate "[위도,경도,타원체높이]"`: PLY 의 (0,0,0)을 이 WGS84 지점에 두고 x→동, y→북, z→위(ENU) 로 정렬한 `root.transform` 을 씁니다. 높이는 `from-gps` 가 권장한 값(지면이 지구 타원체 위 1 m 에 오도록 계산)을 쓰면 됩니다. 도구 안에서 "Offset Height" 로 언제든 상하 조정 가능하고 **거리에는 영향 없음**(평행이동).
- `--no-open-inspector`: 변환 후 자동으로 검사기 브라우저를 여는 동작 끄기.
- `--memory-budget 16`: 메모리 예산(GB). 이 PC 는 125 GB 라 넉넉히.
- 성능이 걱정되면 `--sh 0`(뷰 의존 색 제거, 용량 대폭 감소) 또는 먼저 `simplify --target-count 1000000` 로 가우시안 수를 줄일 수 있습니다. 측정 정확도는 사용자가 점을 얼마나 정확히 조준하느냐에 달려 있으므로 **가늘고 날카로운 구조가 잘 보이는 한** 단순화해도 됩니다.
- 출력 폴더가 있으면 **삭제 후 재생성**하니 경로에 주의.

변환 후 확인:
```bash
python3 -c "import json;d=json.load(open('$HOME/storage/Cesium/3dgs_measurement_tool/public/models/site01/build_summary.json'));print(d.get('source_coordinate_system'), d.get('input_splats'), d.get('converted_splats'), d.get('sh_degree'))"
```
`source_coordinate_system` 이 **z_up** 이면 헤더 주석이 제대로 인식된 것입니다(camera_y_down_z_forward 로 나오면 PLY 주석이 없다는 뜻 → 2단계 스크립트 출력인지 확인).

Site01 실제 변환 결과(2026-09-05, 위 명령 그대로):

```
input_filter | removed=891,013 (opacity<0.05) | kept=1,660,664
nodes=199 | LOD levels=7 | splats=1,660,664 | source_sh_degree=3 | sh_degree=3
source_coordinate_system: z_up          ← 헤더 주석 인식 OK
wall 0:34, maxRSS 3.8 GB                 → 출력 151 MB (tiles/*.glb 199개)
```
- 기본 `--opacity-filter 0.05` 가 불투명도 5 % 미만의 가우시안 35 % 를 제거했습니다(대부분 반투명 floater). 전부 남기려면 `--opacity-filter 0`.
- `tileset.json` 의 `root.transform` 열벡터가 진주 부지 위경도의 동·북·위 방향과 각각 내적 1.0000 으로 일치하고, 원점 타원체 높이 5.9 m 임을 스크립트로 확인했습니다(즉 PLY 의 x,y,z 가 정확히 E,N,U 로 놓임).

---

## 4. 단계 4 — 도구에 모델 등록

방법 1(적용됨): `public/models/<이름>/` 에 tileset 을 두고 `src/pages/Home.jsx` 의 `BASE_MODELS` 배열에 항목 추가. Site01 은 이미 다음이 들어가 있고 첫 항목이라 **기본 선택**됩니다.

```js
const BASE_MODELS = [
  {
    id: "Site_Research_01",
    name: "Site_Research_01 (LH drone, local)",
    tilesetUrls: ["/models/site01/tileset.json"],
    offsetHeight: 0,
  },
  { id: "White Sculpture", name: "White Sculpture (Local)", tilesetUrls: ["/models/white/tileset.json"], offsetHeight: -130 },
];
```
다른 모델을 추가할 때는 같은 형식으로 한 항목을 더 넣으면 됩니다(개발 서버는 저장 즉시 새로고침).

방법 2(코드 수정 없이): 도구 왼쪽 패널 **Model ▸ URL Model ▸ Edit** 에 `http://localhost:5173/models/site01/tileset.json` 을 입력하고 Save. 새로고침하면 다시 입력해야 합니다.

방법 3: 논문 저자들처럼 S3(공개 버킷 + CORS) 에 올려 "Custom S3 Model" 로 로드(`.env.local` 의 `VITE_S3_BUCKET`, `VITE_AWS_REGION`). 로컬 작업엔 불필요.

---

## 5. 단계 5 — 도구 실행

```bash
~/storage/Cesium/tools/start_tool.sh
#   (= conda activate cesium_measure && cd 3dgs_measurement_tool && npm run dev)
```
터미널에 `Local: http://localhost:5173/` 이 뜨면 **Chrome** 으로 접속합니다(WebGL2 필요, 이 PC 에 `google-chrome` 있음). 끝낼 때는 터미널에서 Ctrl+C.
(2026-09-05 검증: 서버 기동 0.5 초, `/`, `/models/site01/tileset.json`, 첫 타일 `tiles/0/0.glb`(1.3 MB), 수정된 `Home.jsx` 모두 HTTP 200. 브라우저 렌더링·클릭은 GUI 라 미검증.)
다른 PC 에서 접속하려면 `start_tool.sh` 안의 주석대로 `-- --host 0.0.0.0` 을 붙이고 `http://<이 PC IP>:5173` 으로 엽니다.

첫 화면
- 왼쪽 패널 **Model** 드롭다운에 "Site_Research_01 (LH drone, local)" 이 선택되어 있고, 지구가 진주 LH 부지(35.1778°N, 128.1469°E) 로 날아갑니다. 처음 로드는 타일을 내려받느라 수십 초 걸릴 수 있습니다.
- 지구 배경 영상(Bing)은 저장소에 포함된 저자들의 Cesium ion 토큰으로 나옵니다. 오래 쓰려면 ion.cesium.com 무료 계정을 만들어 `src/components/CesiumViewer.jsx` 15행의 토큰을 교체하세요(측정 기능 자체는 토큰과 무관).
- **Offset Height**(m): 모델이 지구 표면에 묻혀 보이면 +, 떠 있으면 − 로 조정. 평행이동이므로 거리 불변.

Cesium 기본 카메라 조작
| 동작 | 마우스 |
|---|---|
| 회전(지구 돌리기/이동) | 왼쪽 드래그 |
| 확대/축소 | 휠, 또는 오른쪽 드래그 |
| 기울이기(틸트)·궤도 회전 | 가운데 버튼 드래그, 또는 Ctrl + 왼쪽/오른쪽 드래그 |
| 모델로 다시 가기 | 오른쪽 위 홈(집 모양) 버튼 — 저장소 코드가 로드된 tileset 으로 날아가게 바꿔 놓았음 |

F12 콘솔에 `[CesiumViewer] tileset loaded` 로그가 보이면 로드 성공, `Error loading tileset` 이면 10장 참고.

---

## 6. 단계 6 — 점 측정 (논문 Algorithm 1 그대로)

1. 왼쪽 패널 **Points** 탭 → **Start Measure**.
2. 측정하려는 특징점(모서리, 표지판 끝, 기둥 밑동 등)이 화면 중앙에 크게 보이도록 **충분히 확대**합니다. 논문도 "서브픽셀 조준을 위해 크게 확대"를 강조합니다.
3. 그 점을 **한 번 클릭** → 노란 광선(카메라→클릭 방향)이 생깁니다.
4. 카메라를 **다른 각도로 옮겨서**(틸트/회전, 20~40° 이상 차이 나게) 같은 점을 다시 확대 후 클릭. 
5. 4를 반복해 **총 5개 이상**의 광선을 모읍니다(논문 실험 N=5; 최소 2개면 계산되지만 잉여도 r=2N−3 이 커야 σ 가 의미 있음). 서로 다른 방향에서 골고루(한쪽에 몰리면 광선이 거의 평행해져 깊이 방향 오차가 커짐).
6. **End Measure** → 최소제곱 교회점이 계산되고 목록에 `(위도, 경도, 고도) | σ = 0.0xx m` 로 추가됩니다. σ 는 σ̂₀ = √(vᵀv/(2N−3)), 즉 **광선들이 계산된 점에서 평균 얼마나 떨어져 있는가**(m) 입니다. 잘 조준하면 수 cm 이하, 잘못 클릭한 광선이 섞이면 커집니다 → 그 점을 지우고 다시.
7. **Error Ellipsoid / Simple Point** 토글로 공분산 타원체(파랑)를 볼 수 있습니다. 길쭉한 방향이 약한 방향(보통 광선들의 공통 깊이 방향) → 그 방향에 수직인 시점을 추가하면 개선됩니다.

중요한 구현상 특성(코드에서 확인)
- 클릭 위치는 `camera.pickEllipsoid` 로 **지구 타원체와의 교점**을 구해 광선 방향으로만 씁니다. 따라서 **클릭 방향이 지구 표면을 향해야**(수평선 아래) 광선이 기록됩니다. 하늘을 배경으로 위를 올려다보며 클릭하면 무시됩니다 → 약간이라도 내려다보는 시점에서 클릭하고, 모델을 Offset Height 로 지표 근처에 두세요.
- 광선 원점은 클릭 순간의 카메라 위치(ECEF)입니다. 시점을 바꾸지 않고 여러 번 클릭하면 광선이 거의 같아 잉여가 늘지 않습니다(논문 2.1.3 절 지적과 동일).
- 점 삭제: 목록에서 선택 후 **Delete**. 목록 항목 클릭 → 3D 뷰에서 하이라이트.

---

## 7. 단계 7 — 거리 계산

### 방법 1: 점 2개 → CSV → 스크립트
1. 6단계로 거리 양 끝점 A, B 를 각각 측정(각 5광선).
2. Points 탭 **Export ▸ As CSV** → `points.csv` 다운로드(헤더 `id,lon,lat,alt,accuracy`).
3. 계산:
```bash
python3 ~/storage/Cesium/tools/measure_distance.py ~/Downloads/points.csv --pairs 1-2
python3 ~/storage/Cesium/tools/measure_distance.py ~/Downloads/points.csv --all      # 모든 쌍
```
출력: 거리(m), 두 점의 σ, 그리고 대략적 거리 불확도 √(σ_A²+σ_B²). (위경도·고도 → WGS84 ECEF → 유클리드 거리. Cesium 과 같은 타원체라 도구 내부 좌표와 동일.)

### 방법 2: 폴리라인
Polylines 탭 → **Create Polyline** → 측정된 점들을 3D 뷰에서 클릭하거나 "Available Measured Points" 에서 선택 → Finish → **Export ▸ CSV**(`geometry_id,point_order,lon,lat,alt`)
```bash
python3 ~/storage/Cesium/tools/measure_distance.py ~/Downloads/polylines.csv --chain   # 구간별·누적 길이
```
GeoJSON 내보내기도 같은 스크립트로 읽습니다.

### 결과 해석
- 최종 거리 오차 ≈ (조준 오차: 논문 기준 1~2 cm) ⊕ (축척 오차 × 거리). Site01 의 GPS 축척은 ±1~2 % 이므로 지금 상태에서 10 m 는 ±10~20 cm 수준입니다. → 8단계.

---

## 8. 단계 8 — 축척 검증·보정 (정확도를 cm 로 올리는 단계)

1. 현장에서 길이를 아는 구간을 고릅니다. 예: 줌자로 실측한 창문 폭, 두 GCP 사이 거리(DS003 은 `gcp_coordinates.csv` 로 계산 가능), TLS 점군에서 잰 길이.
2. 도구에서 그 구간의 양 끝을 측정(각 5광선 이상) → CSV.
3. 축척계수 계산:
```bash
python3 ~/storage/Cesium/tools/measure_distance.py points.csv --calibrate 1 2 12.500   # id 1-2 의 실측 12.500 m
#  → 축척계수 s = 실측/측정
```
4. 반영 방법 두 가지
   - 간단: 이후 모든 거리 계산에 `--scale s` 를 붙입니다.
   - 근본: PLY 를 다시 스케일하고 3~4단계를 다시 돌립니다.
     ```bash
     python3 ~/storage/Cesium/tools/gs_ply_georef.py apply --ply ~/storage/Cesium/data/site01/site01_enu.ply \
       --out ~/storage/Cesium/data/site01/site01_enu_cal.ply --scale <s> --local-origin 0 0 0
     ```
5. 가능하면 **서로 다른 방향·길이의 기준 구간 2~3개**로 확인하세요. 축척이 방향에 따라 다르면(드리프트) COLMAP 재구성 자체의 문제이므로 GCP 를 더 넣어 재구성하는 것이 맞습니다.

논문과 같은 방식의 정량 평가를 하려면: 검증점(VP) 여러 개를 TLS/측량 좌표로 준비 → 도구로 각 VP 를 N=5 로 측정 → RMSE/ME/Std 계산(논문 Table 2 형식). DS003 은 GCP 5점과 BLK360 정합 점군이 있으니 바로 가능합니다.

---

## 9. 다른 모델에 반복 적용 체크리스트

```bash
conda activate cesium_measure
# 1) 미터화 (A 또는 B)
python3 ~/storage/Cesium/tools/gs_ply_georef.py from-gps --ply <PLY> --images <sparse/0/images.bin> --photos <원본사진> --out ~/storage/Cesium/data/<name>/<name>_enu.ply
#    또는 apply --scale ...
# 2) 3D Tiles (위경도·높이는 위 JSON 의 recommended_coordinate)
npx --yes 3dgs-ply-3dtiles-converter@0.6.5 ~/storage/Cesium/data/<name>/<name>_enu.ply \
    ~/storage/Cesium/3dgs_measurement_tool/public/models/<name> --coordinate "[lat,lon,h]" --no-open-inspector --memory-budget 16
# 3) Home.jsx BASE_MODELS 에 { id, name, tilesetUrls:["/models/<name>/tileset.json"], offsetHeight:0 } 추가
# 4) ~/storage/Cesium/tools/start_tool.sh → 측정 → Export → measure_distance.py
```

---

## 10. 문제 해결

| 증상 | 원인/대처 |
|---|---|
| 모델이 안 보이고 지구만 보임 | F12 콘솔 확인. `tileset loaded` 인데 안 보이면 홈 버튼으로 이동, Offset Height 를 ±수십 m 조정. 지구 아래에 있으면 가려짐. |
| `Error loading tileset ... 404` | `public/models/<name>/tileset.json` 경로 확인. URL 모델이면 `http://localhost:5173/models/...` 전체 URL. |
| 모델이 뒤집힘/기울어짐 | 2단계 스크립트를 거치지 않은 원본 PLY 를 변환한 경우(변환기가 −Y 를 위로 가정). `from-gps` 결과 PLY 로 재변환. |
| 렌더가 느리거나 GPU 오류(Vertex buffer) | 도구가 자동으로 `maximumScreenSpaceError` 를 올려 재시도함(콘솔 로그). 근본 대책: 변환 시 `--sh 0`, `simplify --target-count 1000000`. |
| 클릭해도 광선이 안 생김 | Start Measure 상태인지, 클릭 방향이 지구 표면을 향하는지(하늘 배경 불가) 확인. |
| σ 가 수십 cm 이상 | 광선 하나가 다른 점을 찍었을 가능성 → 점 삭제 후 재측정. 시점 차이를 더 크게. |
| `npm: command not found` | `conda activate cesium_measure` 를 안 한 것. |
| 포트 5173 사용 중 | `npm run dev -- --port 5174` (vite.config.js 의 port 도 참고). |
| 변환기 메모리 오류 | `--memory-budget` 조정, 또는 `simplify` 로 먼저 축소. |
| 2DGS PLY 변환 실패 (`scale_2` 없음) | `convert_2dgs_to_3dgs_ply.py` 산출물 사용. |

---

## 부록 A — 논문 수식과 도구 구현의 대응

도구(`src/components/CesiumViewer.jsx` 의 `computeIntersectionLocal`)는 논문 식 (3)~(8)과 수학적으로 동치인 "직선들에 가장 가까운 점" 형태를 씁니다:

- Σᵢ (I − dᵢdᵢᵀ) x = Σᵢ (I − dᵢdᵢᵀ) Cᵢ  →  x = [Σ(I − ddᵀ)]⁻¹ Σ(I − ddᵀ)C   (= 정규방정식 (AᵀA)⁻¹Aᵀb)
- 잔차 vᵢ = (I − dᵢdᵢᵀ)(x − Cᵢ) (점에서 광선까지의 수직 벡터), σ̂₀² = Σ‖vᵢ‖² / (2N − 3)
- 공분산 Q = σ̂₀² [Σ(I − ddᵀ)]⁻¹ → 고유분해로 타원체 축·방향
- 광선: 원점 = `camera.positionWC`, 방향 = 원점 → `pickEllipsoid(클릭)` 정규화
- 결과는 ECEF → `Cartographic` 로 위경도·고도 표시, CSV 의 `accuracy` = σ̂₀(m)

## 부록 B — Cesium ion 으로 변환하는 대안 경로

로컬 변환기 대신 Cesium ion(무료 커뮤니티 계정)에 PLY 를 업로드해 타일링할 수도 있습니다.
- 업로드 시 소스 유형 **Point Cloud**, 옵션 **Gaussian splats** 활성화(REST 로는 `{"sourceType":"POINT_CLOUD","options":{"gaussianSplats":true}}`).
- 지오리퍼런싱은 **My Assets ▸ Adjust Tileset Location**(위치 검색 → 위치·회전·축척 대화식/폼 조정 → Save). 축척계수를 정밀하게 넣기 어렵다는 사용자 보고가 있으므로 축척은 여전히 2단계 스크립트로 PLY 에 미리 넣는 편이 낫습니다.
- 도구는 URL 로만 로드하므로 ion 자산을 쓰려면 `CesiumViewer.jsx` 에서 `Cesium.Cesium3DTileset.fromUrl(url, opts)` 호출을 다음처럼 바꾸고 URL 칸에 `ion://<assetId>` 를 넣는 소규모 패치가 필요합니다(미검증):
  ```js
  const m = /^ion:\/\/(\d+)$/.exec(url);
  const p = m ? Cesium.Cesium3DTileset.fromIonAssetId(Number(m[1]), opts) : Cesium.Cesium3DTileset.fromUrl(url, opts);
  ```
  그리고 15행의 ion 토큰을 본인 계정 토큰으로 교체.

## 부록 C — 이번에 만든 파일

```
~/storage/Cesium/
├── 3DGS_거리측정_튜토리얼.md            ← 이 문서
├── tools/
│   ├── gs_ply_georef.py                 PLY 유사변환(info / from-gps / apply)
│   ├── measure_distance.py              CSV/GeoJSON → 거리, --calibrate
│   └── start_tool.sh                    도구 실행
├── data/site01/site01_enu.ply (+.json)  Site01 미터·Z-up PLY 와 변환 메타
└── 3dgs_measurement_tool/               논문 도구 (npm install 완료, Home.jsx 에 Site01 등록)
    └── public/models/site01/            Site01 3D Tiles
```
참고 링크: 논문 https://arxiv.org/abs/2603.24716 · 도구 https://github.com/GDAOSU/3dgs_measurement_tool (docs/OPERATION_GUIDE.md) · 변환기 https://www.npmjs.com/package/3dgs-ply-3dtiles-converter · CesiumJS 3DGS LOD https://cesium.com/learn/cesiumjs-learn/3d-guassian-splat-tilesets-lods/ · ion 위치 편집기 https://cesium.com/learn/3d-tiling/ion-tile-set-location/
