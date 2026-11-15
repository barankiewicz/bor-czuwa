"""Reuse tested route, admission, cache and security policy on the dedicated TLS host."""
import argparse
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('domain')
parser.add_argument('--indexing', choices=['public', 'staging'], default='public')
parser.add_argument('--environment-path', default='/opt/bor-czuwa')
parser.add_argument('--config-path', default='/etc/bor-czuwa')
parser.add_argument('--certificate-name', help='Existing Certbot lineage; defaults to domain')
parser.add_argument('--private-gate', type=Path, help='Root-controlled JSON: cookieToken and passwordFile')
args = parser.parse_args()
if not re.fullmatch(r'[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?', args.domain):
    parser.error('Invalid domain')
certificate = args.certificate_name or args.domain
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', certificate):
    parser.error('Invalid certificate name')
for path in [args.environment_path, args.config_path]:
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', path) or '..' in Path(path).parts:
        parser.error('Invalid environment path')
if args.private_gate and args.indexing != 'staging':
    parser.error('Private gate requires staging indexing')
base, etc = args.environment_path, args.config_path
domain = args.domain
installed = Path(__file__).with_name('nginx.template.conf')
template = installed if installed.is_file() else Path(__file__).resolve().parents[2] / 'containers/nginx.conf'
config = template.read_text()
# The public face is the landing on lh.pl, so the app host stays noindex in both modes.
config = 'user www-data;\nerror_log /dev/null crit;\npid /run/nginx.pid;\n' + config
config = re.sub(r'  resolver .*;\n', '', config)
config = config.replace('server app:3001 resolve;', 'server 127.0.0.1:3001;')
config = config.replace('listen 8080;', f'''listen 443 ssl;
    listen [::]:443 ssl;
    ssl_certificate /etc/letsencrypt/live/{certificate}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{certificate}/privkey.pem;
    http2 on;
    # Mozilla "intermediate" without the finite-field suites, so no DH parameters are needed.
    # The certificate is Let's Encrypt's, which no longer carries an OCSP responder URL: stapling stays off.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_ecdh_curve X25519:prime256v1:secp384r1;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;''')
config = config.replace('server_name _;', f'server_name {domain};')
config = config.replace('proxy_set_header X-Forwarded-Host $http_host;', 'proxy_set_header X-Forwarded-Host $server_name;')
config = config.replace('root /usr/share/nginx/html;', f'root {base}/current/build;')
config = config.replace('/var/lib/bor-czuwa/', '/var/lib/' + Path(base).name + '/')
include = f'include {base}/current/build/security-headers.conf;'
config = config.replace('include /etc/nginx/security-headers.conf;', include)
# HSTS belongs to this one host name: no includeSubDomains and no preload, so it can never reach barankiewicz.dev.
# max-age is a deploy setting: a root-owned file holding seconds, one year when absent. A short value
# (300 at least) lets the owner ramp up once HTTPS and renewal are seen working.
max_age = Path(etc, 'hsts-max-age')
seconds = max_age.read_text().strip() if max_age.is_file() else '31536000'
if not re.fullmatch(r'[0-9]{3,8}', seconds) or not 300 <= int(seconds) <= 63072000:
    parser.error('hsts-max-age must be 300 to 63072000 seconds')
hsts = f'add_header Strict-Transport-Security "max-age={int(seconds)}" always;'
config = config.replace(include, include + '\n      ' + hsts)
config = config.replace('proxy_set_header X-Real-IP $remote_addr;', '''proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header Forwarded "";''')
if args.private_gate:
    gate = json.loads(args.private_gate.read_text())
    token, password_file = gate['cookieToken'], gate['passwordFile']
    if not re.fullmatch(r'[a-f0-9]{64}', token) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', password_file):
        parser.error('Invalid private gate')
    config = config.replace('http {', f'''http {{
  map $http_cookie $private_browser_realm {{
    default "Private fictional Reports only";
    "~(?:^|; *)__Host-bor_demo={token}(?:;|$)" off;
  }}
  map "$http_origin:$http_x_bor_demo_invitation:$uri" $private_realm {{
    default $private_browser_realm;
    "~^https://localhost:{token}:/api/" off;
  }}
  map "$request_method:$status:$remote_user" $private_cookie {{
    default "";
    "~^(?:GET|HEAD):[23][0-9][0-9]:.+$" "__Host-bor_demo={token}; Path=/; Secure; HttpOnly; SameSite=Strict";
  }}''', 1)
    config = config.replace(f'root {base}/current/build;', f'''root {base}/current/build;
    auth_basic $private_realm;
    auth_basic_user_file {password_file};''')
    # Native requests use the existing invitation capability, not Report Authorization.
    # CORS preflight carries no invitation and must reveal no application data.
    config = config.replace('proxy_set_header Forwarded "";',
                            '''proxy_set_header Forwarded "";
    proxy_set_header X-Bor-Demo-Invitation "";''')
    native_proxy = f'''{include}
      {hsts}
      add_header X-Robots-Tag "noindex, nofollow" always;
      add_header Access-Control-Allow-Origin $cors_origin always;
      add_header Access-Control-Allow-Methods "GET, POST, DELETE" always;
      add_header Access-Control-Allow-Headers "authorization, content-type, x-bor-demo-invitation" always;
      add_header Access-Control-Expose-Headers Retry-After always;
      add_header Vary Origin always;
      add_header Cache-Control "no-store" always;
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_hide_header Access-Control-Expose-Headers;
      proxy_hide_header Vary;
      proxy_hide_header Cache-Control;
      if ($request_method = OPTIONS) {{ return 204; }}
      proxy_pass http://api;'''
    config = config.replace("add_header Access-Control-Allow-Headers 'If-None-Match, If-Modified-Since, Range' always;",
                            "add_header Access-Control-Allow-Headers 'If-None-Match, If-Modified-Since, Range, x-bor-demo-invitation' always;")
    config = config.replace('proxy_pass http://api;', native_proxy)
    # Repeat with canonical security headers: any local add_header cancels inheritance.
    # OPTIONS returns before nginx's access phase; it must never mint a session.
    config = config.replace(include, include + '\n      add_header Set-Cookie $private_cookie always;')
    # A valid private cookie turns Basic off so Report Bearer tokens pass intact.
config = config.replace('http {', f'''http {{
  server {{
    listen 80;
    listen [::]:80;
    server_name {domain};
    client_header_timeout 10s;
    client_body_timeout 10s;
    send_timeout 15s;
    keepalive_timeout 5s;
    limit_conn connections 40;
    limit_conn_status 429;
    if ($request_method !~ ^(?:GET|HEAD)$) {{ return 405; }}
    location ^~ /.well-known/acme-challenge/ {{ root /var/lib/letsencrypt; }}
    location / {{ return 301 https://{domain}$request_uri; }}
  }}''', 1)
print(config)
