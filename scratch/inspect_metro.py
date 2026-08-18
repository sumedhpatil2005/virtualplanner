import sqlite3
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

conn = sqlite3.connect('backend/twincity.db')
cursor = conn.cursor()
cursor.execute("select id, type, geometry_geojson, properties_json from city_objects where type in ('metro_line', 'metro_station')")
for row in cursor.fetchall():
    obj_id, obj_type, geom_str, props_str = row
    geom = json.loads(geom_str)
    props = json.loads(props_str)
    print(f"ID: {obj_id}, Type: {obj_type}")
    print(f"  Geometry: {geom[:3]} ... (len: {len(geom)})" if isinstance(geom, list) else f"  Geometry: {geom}")
    print(f"  Properties: {list(props.keys())} -> elevation: {props.get('elevation')}, pierSpacing: {props.get('pierSpacing')}")
conn.close()
