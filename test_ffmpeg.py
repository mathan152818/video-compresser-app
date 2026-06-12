import subprocess

p = subprocess.Popen(["python", "-c", "import sys, time; sys.stderr.write('time=1\\r'); sys.stderr.flush(); time.sleep(1); sys.stderr.write('time=2\\r'); sys.stderr.flush()"], stderr=subprocess.PIPE, universal_newlines=True)
for line in p.stderr:
    print(repr(line))
