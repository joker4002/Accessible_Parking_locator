# KingstonAccess (Accessible Parking Locator)

## English

### Overview

KingstonAccess is an Android app + lightweight Flask backend that helps you:

- Find nearby accessible parking spots around a selected destination in Kingston, Ontario.
- Search destinations using normal autocomplete or natural language **AI Search**.
- Visualize routes on the map:
  - Driving route (red) to the selected parking spot.
  - Walking route (blue) from the parking spot to the destination.

### Tech Stack

- **Android**: Kotlin, Jetpack Compose, Google Maps Compose
- **Backend**: Python (Flask), Requests
- **External services**:
  - OpenStreetMap Nominatim (place search)
  - backboard.io (LLM intent parsing for AI Search)
  - Google Directions API (routes)

### Project Structure

- `Android/` Android application
- `backend/` Flask server
- `source/` Data files used by the backend (`Parking_Lot_Areas.geojson`, `Parking_Lot_Areas.csv`)

### Backend API

The Android app calls the backend using the base URL configured in the Android string resource `backend_base_url`.

- `GET /autocomplete?q=...&limit=...`  
  Returns a list of candidate places.
- `GET /nearby?lat=...&lng=...&radius_m=...&limit=...`  
  Returns nearby accessible parking spots with a probability score.
- `GET /ai/search?q=...` (also accepts `min_lat/min_lng/max_lat/max_lng`)  
  Parses a natural language query and returns places + nearby spots.

### Run Backend (Local)

1. Install dependencies

   ```bash
   pip install -r backend/requirements.txt
   ```

2. (Optional) Configure AI Search (backboard)

   Set environment variables:

   - `BACKBOARD_API_KEY` (required to enable LLM intent parsing)
   - `BACKBOARD_MODEL_NAME` (default: `google/gemini-3-flash-preview`)

3. Start the server

   ```bash
   python backend/main.py
   ```

The backend starts on `http://0.0.0.0:8000` so Android emulator can access it via `http://10.0.2.2:8000`.

### Run Android App

1. Open `Android/` in Android Studio
2. Ensure `backend_base_url` points to your backend:
   - Emulator: `http://10.0.2.2:8000`
   - Real device: use your machine LAN IP, e.g. `http://192.168.x.x:8000`

### API Keys / Security

- **Google Maps key**: do **not** commit it to the repository.
  - This repo uses a placeholder string `YOUR_GOOGLE_MAPS_API_KEY` in Android `strings.xml`.
  - The Android manifest reads the key from the Gradle placeholder `${MAPS_API_KEY}`.
  - Add your key locally (recommended): create/update `Android/local.properties`:

    ```properties
    MAPS_API_KEY=YOUR_REAL_KEY_HERE
    ```

    `Android/local.properties` is ignored by Git (see `.gitignore`).
  - Alternatively, you can set an environment variable `MAPS_API_KEY`.
  - If a key was ever committed/pushed, rotate it immediately.

- **Google Directions API** uses the same Google key in this project.

### License

See `LICENSE`.

---

## Français

### Présentation

KingstonAccess est une application Android avec un backend Flask (Python) qui permet de :

- Trouver des places de stationnement accessibles près d’une destination à Kingston (Ontario).
- Rechercher une destination via l’autocomplétion ou via une **Recherche IA** en langage naturel.
- Afficher les itinéraires sur la carte :
  - Itinéraire en voiture (rouge) vers le stationnement sélectionné.
  - Itinéraire à pied (bleu) du stationnement vers la destination.

### Technologies

- **Android** : Kotlin, Jetpack Compose, Google Maps Compose
- **Backend** : Python (Flask), Requests
- **Services externes** :
  - OpenStreetMap Nominatim (recherche de lieux)
  - backboard.io (analyse d’intention pour la Recherche IA)
  - Google Directions API (itinéraires)

### Structure du projet

- `Android/` Application Android
- `backend/` Serveur Flask
- `source/` Données (`Parking_Lot_Areas.geojson`, `Parking_Lot_Areas.csv`)

### API Backend

- `GET /autocomplete?q=...&limit=...`
- `GET /nearby?lat=...&lng=...&radius_m=...&limit=...`
- `GET /ai/search?q=...` (accepte aussi `min_lat/min_lng/max_lat/max_lng`)

### Lancer le backend (local)

```bash
pip install -r backend/requirements.txt
python backend/main.py
```

Le serveur écoute sur le port `8000`.

### Lancer l’application Android

1. Ouvrir `Android/` dans Android Studio
2. Vérifier `backend_base_url` (émulateur : `http://10.0.2.2:8000`)

### Clés API / Sécurité

- Ne committez jamais la clé Google Maps.
- Le dépôt contient uniquement un placeholder `YOUR_GOOGLE_MAPS_API_KEY`.
- Le manifeste Android lit la clé via le placeholder Gradle `${MAPS_API_KEY}`.
- Configuration locale recommandée : créer/mettre à jour `Android/local.properties` :

  ```properties
  MAPS_API_KEY=VOTRE_CLE_REELLE_ICI
  ```

  `Android/local.properties` est ignoré par Git (voir `.gitignore`).
- Alternative : définir la variable d’environnement `MAPS_API_KEY`.

### Licence

Voir `LICENSE`.

---

## 中文

### 项目简介

KingstonAccess 是一个 Android 应用 + Flask（Python）后端，用于帮助你在 Kingston（Ontario）快速找到无障碍停车资源并规划路线：

- 在目的地附近查找无障碍停车点（含可用概率）。
- 支持普通搜索联想与自然语言 **AI Search**。
- 地图同时展示：
  - 红线：驾车路线（到停车点）。
  - 蓝线：步行路线（停车点到目的地）。

### 技术栈

- **Android**：Kotlin、Jetpack Compose、Google Maps Compose
- **后端**：Python（Flask）、Requests
- **外部服务**：
  - OpenStreetMap Nominatim（地点搜索）
  - backboard.io（AI Search 意图解析）
  - Google Directions API（路线规划）

### 目录结构

- `Android/`：Android 客户端
- `backend/`：Flask 后端
- `source/`：数据文件（`Parking_Lot_Areas.geojson`、`Parking_Lot_Areas.csv`）

### 后端接口

- `GET /autocomplete?q=...&limit=...`：地点候选
- `GET /nearby?lat=...&lng=...&radius_m=...&limit=...`：附近无障碍停车点
- `GET /ai/search?q=...`：自然语言搜索（可带 bounds 参数）

### 本地运行后端

```bash
pip install -r backend/requirements.txt
python backend/main.py
```

后端默认运行在 `8000` 端口，模拟器访问地址是 `http://10.0.2.2:8000`。

### 运行 Android

1. 用 Android Studio 打开 `Android/`
2. 确保 `backend_base_url` 配置正确：
   - 模拟器：`http://10.0.2.2:8000`
   - 真机：填写电脑局域网 IP，例如 `http://192.168.x.x:8000`

### 密钥与安全

- **不要把 Google Maps Key 提交到 GitHub**。
- 本仓库中 `strings.xml` 仅保留占位符 `YOUR_GOOGLE_MAPS_API_KEY`，请在本地自行配置真实 key。
- AndroidManifest 通过 Gradle 占位符 `${MAPS_API_KEY}` 读取密钥。
- 推荐本地配置方式：创建/修改 `Android/local.properties`：

  ```properties
  MAPS_API_KEY=你的真实Key
  ```

  该文件已在 `.gitignore` 中忽略，不会提交到仓库。
- 也可以通过环境变量 `MAPS_API_KEY` 注入。
- 如果 key 曾经被 commit/push，请立刻在 Google Cloud Console 里轮换（重置）该 key。

- **Google Directions API** 在本项目中同样使用这一个 Google Key。

### License

见 `LICENSE`.