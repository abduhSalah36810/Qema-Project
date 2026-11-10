import os, re

for root, dirs, files in os.walk('apps/api/app'):
    for f in files:
        if f.endswith('.py'):
            p = os.path.join(root, f)
            with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                content = fp.read()
                matches = re.findall(r'(class \w*Unit\w*|unit_id|unit\s*=\s*Column|ForeignKey\([\'\"][^\'\"]*unit)', content)
                if matches:
                    print(f"{p}: {set(matches)}")

