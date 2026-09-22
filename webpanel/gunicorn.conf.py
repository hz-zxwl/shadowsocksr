import os

bind = "%s:%s" % (
    os.environ.get("SSR_PANEL_BIND", "127.0.0.1"),
    os.environ.get("SSR_PANEL_PORT", "6677"),
)
workers = 2
accesslog = "-"
errorlog = "-"
timeout = 30
