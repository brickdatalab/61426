"""Hand-computed fixtures for the v8 value-scoring constitution."""
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location('scoring', os.path.join(os.path.dirname(__file__), '30_scoring.py'))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

# correct, early (rem=250 -> e=0.8333), unpriced (mid=0.55 -> u=0.9): +0.75
assert abs(S.tick_value('UP', 'UP', 0.55, 250, +20, 10) - 0.75) < 1e-9
# wrong direction: flat -1.0 regardless of earliness
assert S.tick_value('DOWN', 'UP', 0.55, 250, +20, 10) == -1.0
# MIXED during fire-worthy lead (cushion +30 >= floor 10, lead == settle): -0.25
assert S.tick_value('MIXED', 'UP', 0.55, 250, +30, 10) == -0.25
# MIXED, lead too thin (not fire-worthy): 0
assert S.tick_value('MIXED', 'UP', 0.55, 250, +3, 10) == 0.0
# MIXED, fat lead but on the WRONG side of settle (not fire-worthy by definition): 0
assert S.tick_value('MIXED', 'UP', 0.55, 250, -30, 10) == 0.0
# correct but market already priced it (mid=0.95 -> u=0.1), rem=60 (e=0.2): +0.02
assert abs(S.tick_value('UP', 'UP', 0.95, 60, +20, 10) - 0.02) < 1e-9
# poly invalid tick: correct call earns ZERO unpricedness credit
assert S.tick_value('UP', 'UP', 0.55, 250, +20, 10, poly_ok=False) == 0.0
# floor scales with vol: cushion 30 < floor(100)=50 -> not fire-worthy
assert S.tick_value('MIXED', 'UP', 0.55, 250, +30, 100) == 0.0
print('SCORING FIXTURES OK')
