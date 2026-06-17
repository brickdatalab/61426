import os
import sys

# Ensure both `polymarket_tools` and `analysis` import when running pytest from tools/.
sys.path.insert(0, os.path.dirname(__file__))
