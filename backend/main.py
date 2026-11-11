from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database.connection import engine, Base
from api.router import router
from api.sim_router import router as sim_router
from api.osm_router import router as osm_router
from api.observed_router import router as observed_router, diurnal_router, corrections_router, screenline_router
from api.scenario_router import router as scenario_router
from database.migrations import migrate
from seed import ensure_base_scenario
from api.traffic_data_router import router as traffic_data_router
from api.feasibility_router import router as feasibility_router  # registers fs_* tables (additive)
import traffic_data.models  # noqa: F401  (registers the td_* tables; additive)
from traffic_data.seed import seed_traffic_data
from database.connection import SessionLocal

# Initialize database tables and the mandatory base scenario
Base.metadata.create_all(bind=engine)
migrate(engine)
ensure_base_scenario()
with SessionLocal() as _s:
    seed_traffic_data(_s)

app = FastAPI(
    title="TwinCity Backend Service",
    description="FastAPI service for TwinCity Digital Twin & Urban Planning Platform",
    version="2.0"
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow any origin for testing; restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount core API router
app.include_router(router, prefix="/api")
app.include_router(scenario_router, prefix="/api")
app.include_router(sim_router, prefix="/api")
app.include_router(osm_router, prefix="/api")
app.include_router(observed_router, prefix="/api")
app.include_router(diurnal_router, prefix="/api")
app.include_router(corrections_router, prefix="/api")
app.include_router(screenline_router, prefix="/api")
app.include_router(traffic_data_router, prefix="/api")
app.include_router(feasibility_router, prefix="/api")

@app.get("/")
def read_root():
    return {
        "status": "online",
        "service": "TwinCity Backend",
        "version": "2.0",
        "documentation": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
