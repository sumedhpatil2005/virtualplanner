# UrbanOS (VirtualPlanner)

A map-first city planning, infrastructure and digital-twin workspace for Pune. It has seven workspaces: Explore, Design, Underground, Environment, Simulate, Projects and Reports. Product overview: `docs/urbanos/URBANOS_OVERVIEW.md`.

> The traffic model **fails validation** (UK TAG M3.1; see `docs/ENGINEERING_VALIDATION.md`). The app shows this on every traffic, ODME and emissions output. Treat those numbers as estimates for comparing options, not as forecasts.

## Requirements
- Python 3.11+ and Node 20+.
- A Cesium ion token, needed for terrain and imagery.

## Backend (FastAPI + SQLite)
```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate   macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt          # includes shapely + pyproj for conflict detection
uvicorn main:app --reload --port 8000    # or: python main.py
```
Optional environment variables:
- `TWINCITY_OSM_INDEX` is the path to the local OSM index database. Without it, mapped signals and OSM metro checks don't load.
- `DATABASE_URL` defaults to `twincity.db`.
- `TWINCITY_FEAS_LAYERS` and `TWINCITY_FEAS_FILES` set the feasibility constraint layers.
- `TWINCITY_PDF_FONT_DIR` sets fonts for PDF reports.

Run the tests with `pip install pytest && python -m pytest tests`.

## Frontend (React + Vite + CesiumJS)
```bash
cd frontend
cp .env.example .env    # set VITE_API_BASE=http://localhost:8000 and VITE_CESIUM_ION_TOKEN
npm install
npm run dev             # http://localhost:5173
```
Checks:
- `npx tsc -p tsconfig.app.json --noEmit`. Use this file; `-p .` checks nothing.
- `npm run lint`
- `npm test`
- `npm run build`

## Where things are
- **Design** has categorised drawing tools. **Underground** has tunnel and utility alignments with depth profiles and cross-sections. **Projects** coordinates alternatives, assessments, conflicts and decisions.
- Press `Ctrl/⌘ K` to search workspaces, tools, layers and projects.
- Documentation: `docs/urbanos/` covers the redesign. The older module docs are in `docs/`.
