import os

def search_files(directory, query):
    results = []
    for root, dirs, files in os.walk(directory):
        if "node_modules" in root or ".git" in root or "dist" in root:
            continue
        for file in files:
            if file.endswith(('.ts', '.tsx', '.js', '.py')):
                filepath = os.path.join(root, file)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                    for idx, line in enumerate(lines):
                        if query.lower() in line.lower():
                            results.append((filepath, idx + 1, line.strip()))
                except Exception as e:
                    pass
    return results

res = search_files('frontend/src', 'gateway')
for path, line_no, content in res[:100]:
    print(f"{path}:{line_no}: {content[:100]}")
