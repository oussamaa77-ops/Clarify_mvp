import os
import re

def make_normal_weight(filepath):
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        return

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Replace the injected style tag to remove font weights and keep it normal
    new_style_tag = """
        <style>{`
          input::placeholder, textarea::placeholder, select::placeholder {
            color: #1e293b !important; /* Dark but not pitch black */
            opacity: 1 !important;
            font-weight: normal !important;
          }
          input, select, textarea {
            color: #0f172a !important;
            font-weight: normal !important;
          }
        `}</style>
"""
    pattern_style = r'<style>\{`[\s\S]*?`\}</style>'
    if re.search(pattern_style, content):
        content = re.sub(pattern_style, new_style_tag.strip(), content)

    # 2. Remove all "font-semibold", "font-medium", "font-bold" from inputs
    content = content.replace(' font-semibold', '')
    content = content.replace('font-semibold ', '')
    
    # 3. Remove inline fontWeight styles
    content = content.replace(', fontWeight: "600"', '')
    content = content.replace(', fontWeight: "500"', '')
    content = content.replace(' fontWeight: "600",', '')
    content = content.replace(' fontWeight: "500",', '')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Processed: {filepath}")

if __name__ == "__main__":
    base_dir = r"c:\Users\fatim\Desktop\Aymane\compta\accounting-saas\frontend\src\app\(dashboard)"
    files = [
        os.path.join(base_dir, "clients", "page.tsx"),
        os.path.join(base_dir, "products", "page.tsx"),
        os.path.join(base_dir, "payments", "page.tsx"),
        os.path.join(r"c:\Users\fatim\Desktop\Aymane\compta\accounting-saas\frontend\src\app", "globals.css")
    ]
    
    for f in files:
        if f.endswith(".css"):
            if os.path.exists(f):
                with open(f, 'r', encoding='utf-8') as css_file:
                    css_content = css_file.read()
                css_content = css_content.replace('font-weight: 500 !important;', 'font-weight: normal !important;')
                with open(f, 'w', encoding='utf-8') as css_file:
                    css_file.write(css_content)
        else:
            make_normal_weight(f)
    print("Done removing bold/semibold.")
