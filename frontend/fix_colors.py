import os
import re

def refine_placeholders(filepath):
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        return

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # The user wants them even darker (pure absolute black)
    new_style_tag = """
        <style>{`
          input::placeholder, textarea::placeholder, select::placeholder {
            color: #000000 !important; /* Absolute pitch black */
            opacity: 1 !important;
            font-weight: 800 !important;
          }
          input, select, textarea {
            color: #000000 !important;
            font-weight: 800 !important;
          }
        `}</style>
"""

    # We previously injected <style>...</style>. We should replace it.
    pattern = r'<style>\{`[\s\S]*?`\}</style>'
    if re.search(pattern, content):
        content = re.sub(pattern, new_style_tag.strip(), content)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"SUCCESS: Upgraded deep CSS style tag to pure black in {filepath}")
    else:
        print(f"FAILED: Could not find existing style tag to upgrade in {filepath}")

if __name__ == "__main__":
    base_dir = r"c:\Users\fatim\Desktop\Aymane\compta\accounting-saas\frontend\src\app\(dashboard)"
    clients_page = os.path.join(base_dir, "clients", "page.tsx")
    products_page = os.path.join(base_dir, "products", "page.tsx")
    
    print("Executing Custom Python CSS Injector Script for Absolute Black...")
    refine_placeholders(clients_page)
    refine_placeholders(products_page)
    print("Script Execution Completed.")
