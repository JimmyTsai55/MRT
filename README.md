# 台北捷運各站進出人次 · 3D 動畫

用 [deck.gl](https://deck.gl) 的 `ColumnLayer` 把北捷每一站的**進站／出站人次**做成兩根 3D 柱，
沿時間軸播放，一眼看出哪幾站在吃掉整個路網的運量、疫情期間又掉得多慘。
底圖是 MapLibre GL，按住右鍵拖曳即可傾斜／旋轉。

```
npm install
npm run dev          # → http://localhost:5173
```

> **repo 附的是真實運量：2018-01 ~ 2021-12，共 48 個月、118 站。**
> 原始資料是臺北市資料大平臺（data.taipei）的各站分時進出量統計，
> 這裡用的是 [HoMuChen/taipei-mrt-data](https://github.com/HoMuChen/taipei-mrt-data) 已經彙整成月統計的版本。
> 2022 年之後要自己從官方站台補，做法見〈換上／更新資料〉。

## 畫面上有什麼

| 元素 | 說明 |
| --- | --- |
| 兩根柱 | 左藍＝進站、右橘＝出站，高度＝當月人次 |
| 折線 | 六條路線，用官方識別色；`環狀線` 2020-01 通車後才會長出柱子 |
| 站名標籤 | 只標當月前幾名，位置會投影到螢幕座標去避開彼此 |
| 右上排行 | 當月前 12 名，名次變動時會滑動換位 |
| 底部時間軸 | 面積圖是全網每月總量，點一下可跳到該月 |

操作：

- `空白鍵` 播放／暫停、`←` `→` 前後一個月
- 拖曳時間軸或點面積圖任一處都可以跳月份
- 滑鼠移到柱子上會出現該站的進出、淨流、名次與歷月走勢
- **右鍵拖曳＝傾斜／旋轉**（MapLibre 原生），滾輪縮放
- 顯示模式：`進＋出`（雙柱）、`進站`、`出站`、`淨流`（出站多的站是橘色）
- 高度 `線性` vs `平方根`：台北車站比第二名大一倍以上，想看清楚中小型站就切平方根

柱高的基準是**整段期間的全域最大值**，不是每月各自正規化，所以不同月份的柱子高度可以直接比較——
2021 年 5 月三級警戒之後整片矮下去（全網從 1.26 億人次/月掉到 2600 萬）就是這樣看出來的。

## 換上／更新資料

現成的資料只到 2021-12。要補上新的年度，官方檔案在
[北捷各站進出量統計](https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136)
（也有一份在 [data.taipei](https://data.taipei/dataset/detail?id=178ebf06-0451-4ac1-bbba-c255ca1fdac6)）。
逐年一個 ODS，各年度排版不一定一致，所以先看檔案長相再轉：

```bash
pip install -r requirements.txt

# 1. 先看官方檔案的結構與程式判定的排版
python3 scripts/prepare_ridership.py --inspect data/raw/各站進出量統計.ods

# 2. 轉成前端要的格式（可一次吃多個年度，會自動合併）
python3 scripts/prepare_ridership.py data/raw/*.ods

# 常用選項
#   --since 2018-01 --until 2024-12   只取這段期間（官方檔頭尾常有不完整的殘月）
#   --layout wide                     自動判斷錯的時候手動指定
#   --source "..."                    寫進 meta.source，會顯示在左上角
```

repo 現在這份是這樣來的（要重跑或驗證的話）：

```bash
mkdir -p data/raw
for y in 2018 2019 2020 2021; do
  curl -sL -o data/raw/$y.csv \
    https://raw.githubusercontent.com/HoMuChen/taipei-mrt-data/master/month/csv/$y.csv
done
python3 scripts/prepare_ridership.py data/raw/*.csv --until 2021-12
```

（`--until 2021-12` 是因為那份 2021 檔案的尾巴多了一小截不完整的 2022-01，
程式也會自己警告總量異常偏低的月份。）

支援三種常見排版，判斷錯了用 `--layout` 指定：

| 排版 | 長相 |
| --- | --- |
| `long` | 每列一筆：年月／站名／進站人次／出站人次 |
| `wide` | 第一欄年月，其餘每欄一站，另有「類別」欄或不同工作表區分進出 |
| `od` | 起訖對：日期／時段／進站／出站／人次，程式會分別加總成各站的進出量 |

沒有表頭的檔案（像 `站名,年月,進站,出站` 直接開始）會看內容猜欄位，不用先自己加標題列。
逐日的資料會自動收斂成月統計。站名也會正規化：`臺`→`台`、去掉括號與結尾的「站」、
去掉路線代碼前綴（板橋有兩組閘門，官方分成 `BL板橋` / `Y板橋`，會自動加總回同一站）。
對不到座標的站會在 stderr 列出來，補進 `scripts/prepare_ridership.py` 的 `ALIASES` 就好。

如果只是想看動畫效果、不想處理資料，`python3 scripts/generate_demo_ridership.py`
會產生一份 2019–2025 的模擬資料（左上角會標成黃色警告，說明那不是官方數字）。

解析邏輯有煙霧測試（自己造假檔跑三種排版）：

```bash
python3 scripts/test_prepare_ridership.py
```

## 專案結構

```
index.html                     版面（面板、時間軸都是普通 DOM）
src/
  main.js                      地圖／動畫迴圈／控制項
  layers.js                    deck.gl 圖層（PathLayer + ColumnLayer ×2 + TextLayer）
  data.js                      載入、內插取值、數字格式
  ui.js                        排行榜、時間軸面積圖、tooltip
  basemap.js                   底圖樣式與初始視角
public/data/
  stations.json                118 個實體車站（轉乘站已合併）
  lines.json                   六條路線的折線座標（含支線）
  ridership.json               每站每月進出人次（目前是 2018-01 ~ 2021-12 的真實資料）
scripts/
  build_stations.py            原始站點 GeoJSON → stations.json / lines.json
  generate_demo_ridership.py   產生模擬示範資料
  prepare_ridership.py         官方 ODS/CSV → ridership.json
  test_prepare_ridership.py    上面那支的煙霧測試
  bundle_singlefile.mjs        打包成單一 HTML（見下）
data/source/                   原始站點資料（進版控管，方便重跑）
```

資料格式（`ridership.json`）：

```jsonc
{
  "meta": { "synthetic": false, "unit": "人次", "granularity": "month" },
  "periods": ["2019-01", "2019-02", "..."],
  "stations": [{ "id": "R10", "in": [1234, 1111], "out": [1300, 1180] }]
}
```

`in` / `out` 的長度必須等於 `periods`，`id` 對應 `stations.json` 的站號。
自己接後端（FastAPI 之類）的話，出一樣的 JSON 就能直接換掉。

## 打包

```bash
npm run build                        # → dist/
node scripts/bundle_singlefile.mjs   # → dist/standalone.html（單檔，含資料）
```

`dist/` 是純靜態檔，丟 GitHub Pages / CDN 都可以（`vite.config.js` 已設 `base: './'`）。
單檔版仍需要用 http(s) 開啟（`npx vite preview` 或 `python3 -m http.server`）——
瀏覽器不允許 `file://` 頁面建立 MapLibre 需要的 worker。

## 幾個實作上的取捨

- **轉乘站合併成一筆**：官方統計表一站一列，所以 `台北車站` 只會有一組柱子，
  座標取各線月台的平均。`stations.json` 裡保留 `codes` 與 `lines` 兩個欄位。
- **路線折線用站點順序連出來**，不是實際軌道線形。在這個尺度下看起來更乾淨，
  也不用處理官方線形資料裡的舊路線分段。
- **柱子每幀內插**：`valueAt()` 在相鄰兩個月之間做線性內插，柱子是連續長高，
  不是一格一格跳。時間軸也因此可以停在月與月之間。
- **標籤避讓在螢幕空間做**：柱子越高標籤越上面，只比經緯度會誤判，
  所以用 `WebMercatorViewport` 把柱頂投影成螢幕座標再判斷重疊。
- **環狀線**：2023-05-23 起改由新北大眾捷運營運，北捷的統計表已不含這條線；
  資料裡仍保留這 14 站（`operator: "NTMetro"`），真實資料轉進來後它們會是 0。

## 已知限制

- **廣慈／奉天宮（R01，2023 年通車）沒有座標**，來源資料還沒收錄，所以圖上沒有這一站。
  官方統計表若有這站，轉檔時會在 stderr 提醒對不到；補上座標重跑 `build_stations.py` 即可。
- 底圖（CARTO 的 dark-matter／positron）需要連網。抓不到時會自動退回純色背景，
  柱狀圖與路線照樣可以看，也可以直接在底圖切成「無」。
- 現成資料只到 2021-12。2022 年之後要自己從官方站台下載補上（見上面）。
- 目前只做到「各站進出量」。要做 OD 流向（哪裡到哪裡）得換 `ArcLayer` 或 `TripsLayer`，
  資料源要改用分時 OD 表。

## 資料來源

- 站點座標：[repeat/northern-taiwan-metro-stations](https://github.com/repeat/northern-taiwan-metro-stations)
  （原始資料來自臺北市資料大平臺 data.taipei）
- 運量統計：[臺北市資料大平臺　臺北捷運各站分時進出量統計](https://data.taipei/dataset/detail?id=178ebf06-0451-4ac1-bbba-c255ca1fdac6)，
  月統計彙整版取自 [HoMuChen/taipei-mrt-data](https://github.com/HoMuChen/taipei-mrt-data)；
  最新年度請至 [北捷各站進出量統計](https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136)
- 路線識別色：北捷官方色票
