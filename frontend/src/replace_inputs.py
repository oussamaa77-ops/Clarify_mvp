import os
import re

directory = r"c:\Users\fatim\Desktop\Aymane\compta\accounting-saas\frontend\src"

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # We want to find <input ... className="..." ... > and <select ... className="..." ... >
    # This regex is a bit simplistic but works for well-formatted JSX
    new_content = content
    
    # regex to find className string within input or select tags
    # we'll look for className="[^\"]*" and if it's an input/select we'll inject the classes
    # actually, safer to just replace instances of `border-slate-300` in JSX with the new classes
    # if it doesn't already have text-slate-500
    
    pattern = re.compile(r'(<(?:input|select)\b[^>]*className="[^"]*)(")')
    
    def replacer(match):
        prefix = match.group(1)
        suffix = match.group(2)
        
        # don't add if already there
        if "text-slate-500" not in prefix:
            prefix += " placeholder-slate-400 text-slate-500"
        
        # if it had text-slate-800 or text-slate-900 or whatever, maybe we should replace it?
        # for safety, we just inject it and let tailwind handle it if there are duplicates (last wins conceptually, though tailwind behavior varies)
        # actually, let's remove text-slate-800 or text-gray-900 if they exist
        prefix = re.sub(r'\btext-slate-\d00\b', '', prefix)
        prefix = re.sub(r'\btext-gray-\d00\b', '', prefix)
        prefix = prefix + " placeholder-slate-400 text-slate-500"
        
        # clean up double spaces
        prefix = re.sub(r'\s+', ' ', prefix)
        
        return prefix + suffix

    new_content = pattern.sub(replacer, content)

    if new_content != content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for root, _, files in os.walk(directory):
    for file in files:
        if file.endswith('.tsx'):
            process_file(os.path.join(root, file))
