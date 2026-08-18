import sqlite3
import json

conn = sqlite3.connect('backend/twincity.db')
cursor = conn.cursor()
cursor.execute("select id, properties_json from city_objects where type='road' limit 5")
for row in cursor.fetchall():
    obj_id, props_str = row
    props = json.loads(props_str)
    print(f"Road ID: {obj_id}")
    print(f"  Keys: {list(props.keys())}")
    print(f"  bridge: {props.get('bridge')}, tunnel: {props.get('tunnel')}, osmProvenance: {props.get('osmProvenance') is not None}")
conn.close()
