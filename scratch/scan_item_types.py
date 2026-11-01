import os, re, sys
sys.stdout.reconfigure(encoding='utf-8')

backend_vals = set()
frontend_vals = set()

# Search backend
for root, dirs, files in os.walk('apps/api'):
    for f in files:
        if f.endswith('.py'):
            p = os.path.join(root, f)
            with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                txt = fp.read()
                # Find item_type == '...', item_type in [...], item_type='...'
                m = re.findall(r'item_type\s*(?:==|in|=)\s*([\'"\[][^\n\)]+)', txt)
                for match in m:
                    strings = re.findall(r'[\'"]([a-zA-Z0-9_\-]+)[\'"]', match)
                    backend_vals.update(strings)
                    print(f'{p}: {match.strip()} -> {strings}')

# Search frontend
for root, dirs, files in os.walk('apps/web/src'):
    for f in files:
        if f.endswith(('.ts', '.tsx')):
            p = os.path.join(root, f)
            with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                txt = fp.read()
                m = re.findall(r'item_type\s*(?:===|==|in|=)\s*([\'"\[][^\n\)]+)', txt)
                for match in m:
                    strings = re.findall(r'[\'"]([a-zA-Z0-9_\-]+)[\'"]', match)
                    frontend_vals.update(strings)
                    print(f'{p}: {match.strip()} -> {strings}')

print('\n=== SUMMARY ===')
print('Backend item_type string literals:', sorted(backend_vals))
print('Frontend item_type string literals:', sorted(frontend_vals))
