from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database.connection import engine, Base
from api.router import router
from api.sim_router import router as sim_router
from api.osm_router import router as osm_router
from seed import ensure_base_scenario

# Initialize database tables and the mandatory base scenario
Base.metadata.create_all(bind=engine)
ensure_base_scenario()

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
app.include_router(sim_router, prefix="/api")
app.include_router(osm_router, prefix="/api")

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
