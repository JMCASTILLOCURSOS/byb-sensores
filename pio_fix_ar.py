Import("env")

import hashlib
import os
import re

from SCons.Subst import quote_spaces

WINPATHSEP_RE = re.compile(r"\\([^\"'\\]|$)")


def _ar_esc(arg):
    arg = quote_spaces(str(arg))
    return WINPATHSEP_RE.sub(r"/\1", arg)


def _ar_file(env, data):
    build_dir = env.subst("$BUILD_DIR")
    if not os.path.isdir(build_dir):
        os.makedirs(build_dir)
    name = hashlib.md5(data.encode("utf-8")).hexdigest()
    tmp_file = os.path.join(build_dir, "arcmd-%s.tmp" % name)
    if not os.path.isfile(tmp_file):
        with open(tmp_file, mode="w", encoding="utf-8") as fp:
            fp.write(data)
    return tmp_file


def ar_sources_hook(env, sources):
    if isinstance(sources, str):
        items = [s for s in sources.split(" ") if s]
    else:
        items = [str(s) for s in sources]
    data = " ".join(_ar_esc(s) for s in items) + "\n"
    tmp = _ar_file(env, data)
    if " " in tmp:
        return '@"%s"' % tmp
    return "@" + tmp


env["_ar_sources_hook"] = ar_sources_hook

_arcom = env.get("ARCOM", "$AR $ARFLAGS $TARGET $SOURCES")
_arcom = _arcom.replace(
    "${_long_sources_hook(__env__, SOURCES)}",
    "${_ar_sources_hook(__env__, SOURCES)}",
)
if "_ar_sources_hook" not in _arcom:
    _arcom = _arcom.replace("$SOURCES", "${_ar_sources_hook(__env__, SOURCES)}")
env.Replace(ARCOM=_arcom, MAXLINELENGTH=512)

try:
    _m = os.path.join(os.environ.get("TEMP", "."), "pio_fix_ar.marker")
    with open(_m, "w", encoding="utf-8") as _f:
        _f.write("ARCOM=%s\n" % env.get("ARCOM", "?"))
except Exception:
    pass
