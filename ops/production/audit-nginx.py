"""Reject effective nginx logging and untrusted forwarding before activation."""
import re
import subprocess

TLS_CIPHERS = {'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384',
               'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305'}
METHODS = {'GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'}
ERROR_CODES = {'400', '403', '404', '405', '408', '413', '414', '431', '500', '502', '503', '504'}


def blocks(config, opener):
    """Yield (header, body) for each block whose header matches opener; braces inside quotes do not count."""
    for match in re.finditer(opener + r'\s*\{', config):
        depth, quote, start = 1, None, match.end()
        for index in range(start, len(config)):
            char = config[index]
            if quote:
                quote = None if char == quote else quote
            elif char in '\'"':
                quote = char
            elif char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    yield match.group(0), config[start:index]
                    break


def seconds(value):
    match = re.fullmatch(r'(\d+)([sm]?)', value.strip())
    return int(match.group(1)) * (60 if match.group(2) == 'm' else 1) if match else None


def audit_tls_and_requests(config):
    if re.findall(r'\bssl_protocols\s+([^;]+);', config) != ['TLSv1.2 TLSv1.3'] * len(re.findall(r'\bssl_protocols\b', config)) \
            or not re.search(r'\bssl_protocols\b', config):
        raise ValueError('tls_versions')
    ciphers = re.findall(r'\bssl_ciphers\s+([^;]+);', config)
    if not ciphers or any(not set(value.split(':')) <= TLS_CIPHERS for value in ciphers):
        raise ValueError('tls_ciphers')
    if re.findall(r'\bssl_prefer_server_ciphers\s+([^;]+);', config) != ['off'] * len(ciphers):
        raise ValueError('tls_cipher_order')
    if set(re.findall(r'\bssl_session_tickets\s+([^;]+);', config)) != {'off'}:
        raise ValueError('tls_session_tickets')
    # Stapling needs an OCSP responder URL in the certificate and a resolver; never half-enabled.
    if re.search(r'\bssl_stapling\s+on;', config) and not (
            re.search(r'\bssl_stapling_verify\s+on;', config) and re.search(r'\bresolver\s', config)):
        raise ValueError('tls_stapling')
    if not re.search(r'\bhttp2\s+on;', config):
        raise ValueError('http2_required')
    includes = re.findall(r'include\s+[^;]*security-headers\.conf;', config)
    hsts = re.findall(r'add_header\s+Strict-Transport-Security\s+"([^"]+)"\s+always;', config)
    if not hsts or len(hsts) != len(includes) or len(set(hsts)) != 1 or any(
            not re.fullmatch(r'max-age=(\d+)', value) or int(value[8:]) < 300 for value in hsts):
        raise ValueError('hsts_required_on_host_only')
    if re.search(r'includeSubDomains|preload', config, re.IGNORECASE):
        raise ValueError('hsts_must_not_cover_other_names')
    for directive, limit in [('client_header_timeout', 30), ('client_body_timeout', 30), ('send_timeout', 30),
                             ('keepalive_timeout', 30), ('proxy_connect_timeout', 10), ('proxy_send_timeout', 30),
                             ('proxy_read_timeout', 30)]:
        values = [seconds(value) for value in re.findall(r'\b' + directive + r'\s+([^;]+);', config)]
        if not values or any(value is None or value > limit for value in values):
            raise ValueError('timeouts_required')
    servers = len(list(blocks(config, r'\bserver')))
    for directive in ['client_header_timeout', 'client_body_timeout', 'send_timeout']:
        if len(re.findall(r'\b' + directive + r'\b', config)) < servers:
            raise ValueError('timeouts_required')
    if not re.search(r'\blarge_client_header_buffers\s+[1-4]\s+(?:[1-8]k);', config) \
            or not re.search(r'\bclient_header_buffer_size\s+[1-4]k;', config):
        raise ValueError('header_buffers_required')
    if len(re.findall(r'\blimit_conn\s+connections\s+\d+;', config)) < servers:
        raise ValueError('limit_conn_required')
    for header, body in blocks(config, r'\blocation\s+[^{;]+?'):
        # Internal locations (named, or the auth_request subrequest) cannot be reached from outside.
        if header.split()[1].startswith('@') or re.search(r'\binternal;', body) \
                or not re.search(r'\b(?:proxy_pass|try_files|alias)\b', body):
            continue
        allowed = re.search(r'if\s+\(\$request_method\s+!~\s+\^\(\?:([A-Z|]+)\)\$\)\s*\{\s*return\s+405;\s*\}', body)
        if not allowed or not set(allowed.group(1).split('|')) <= METHODS:
            raise ValueError('method_allowlist_required')
    for pattern in [r'location\s+~\s+/\\\.\(\?!well-known/\)\s*\{\s*return\s+404;\s*\}',
                    r'location\s+~\*\s+\(\?:~\|\\\.\(\?:[a-z|]*bak[a-z|]*\)\)\$\s*\{\s*return\s+404;\s*\}']:
        if not re.search(pattern, config):
            raise ValueError('hidden_files_required')
    covered = {code for codes, _ in re.findall(r'error_page\s+([\d ]+?)\s*=\s*(@\w+);', config) for code in codes.split()}
    if not ERROR_CODES <= covered:
        raise ValueError('quiet_errors_required')
    # Every error location repeats the security headers (a location's own add_header drops the inherited ones).
    errors = list(blocks(config, r'location\s+(?:@e\d+|=\s+/_e/\d+)'))
    if len(errors) < 2 * len(ERROR_CODES):
        raise ValueError('quiet_errors_required')
    for _, body in errors:
        if (re.search(r'nginx', body, re.IGNORECASE) or not re.search(r'return\s+\d+\s+["\'][^;]+["\'];', body)
                or not re.search(r'include\s+[^;]*security-headers\.conf;', body)):
            raise ValueError('quiet_errors_required')

try:
    result = subprocess.run(['nginx', '-T'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    config = re.sub(r'#[^\n]*', '', result.stdout.decode())
    for directive, required in [('access_log', 'off'), ('error_log', '/dev/null')]:
        matches = re.findall(r'\b' + directive + r'\s+([^;]+);', config)
        if not matches or any(value.split()[0] != required for value in matches):
            raise ValueError('persistent_proxy_logging')
    if re.search(r'\b(?:syslog:|real_ip_header|set_real_ip_from)', config):
        raise ValueError('unexpected_proxy_chain')
    if re.findall(r'proxy_set_header\s+X-Real-IP\s+([^;]+);', config) != ['$remote_addr']:
        raise ValueError('untrusted_forwarding')
    if re.findall(r'\bserver_tokens\s+([^;]+);', config) != ['off']:
        raise ValueError('proxy_version_visible')
    for header, required in [('X-Forwarded-Host', '$server_name'), ('X-Forwarded-Proto', '$scheme')]:
        if re.findall(r'proxy_set_header\s+' + header + r'\s+([^;]+);', config) != [required]:
            raise ValueError('untrusted_site_origin')
    if not re.search(r'map\s+\$binary_remote_addr\s+\$client_rate_key\s*\{\s*'
                     r'default\s+\$binary_remote_addr;\s*'
                     r'"~\(\?s\)\^\(\?<ipv6_prefix>\.\{8\}\)\.\{8\}\$"\s+\$ipv6_prefix;\s*\}', config):
        raise ValueError('ipv6_prefix_required')
    zones = re.findall(r'limit_req_zone\s+(\S+)\s+zone=(\w+):\S+\s+rate=([^;]+);', config)
    connections = re.findall(r'limit_conn_zone\s+(\S+)\s+zone=connections:', config)
    if not zones or any(key != '$client_rate_key' for key, _, _ in zones) or connections != ['$client_rate_key']:
        raise ValueError('unbounded_ipv6_rate_key')
    if [(key, rate) for key, name, rate in zones if name == 'places'] != [('$client_rate_key', '1r/s')]:
        raise ValueError('place_rate_required')
    if not re.search(r'location\s+=\s+/api/places\s*\{\s*(?:if\s+\(.*?\)\s*\{[^}]*\}\s*)?limit_req\s+zone=places\s+burst=2\s+nodelay;', config):
        raise ValueError('place_route_limit_required')
    policies = re.findall(r'add_header\s+Permissions-Policy\s+"([^"]+)"\s+always;', config)
    if not policies or any(value != 'camera=(self), geolocation=(self)' for value in policies):
        raise ValueError('app_permissions_required')
    audit_tls_and_requests(config)
    if re.search(r'\bauth_basic\b', config):
        if re.findall(r'\bauth_basic\s+([^;]+);', config) != ['$private_realm']:
            raise ValueError('bearer_incompatible_access_gate')
        if re.search(r'proxy_set_header\s+Authorization\b', config, re.IGNORECASE):
            raise ValueError('report_bearer_must_pass_unchanged')
        cookie = re.search(r'map\s+"\$request_method:\$status:\$remote_user"\s+\$private_cookie\s*\{\s*'
                           r'default\s+"";\s*'
                           r'"~\^\(\?:GET\|HEAD\):\[23\]\[0-9\]\[0-9\]:\.\+\$"\s+'
                           r'"__Host-bor_demo=([a-f0-9]{64}); Path=/; Secure; HttpOnly; SameSite=Strict";\s*\}', config)
        if not cookie:
            raise ValueError('cookie_must_require_successful_authentication')
        token = cookie.group(1)
        browser_gate = ('map $http_cookie $private_browser_realm {\n'
                        '    default "Private fictional Reports only";\n'
                        '    "~(?:^|; *)__Host-bor_demo=' + token + '(?:;|$)" off;\n'
                        '  }')
        native_gate = ('map "$http_origin:$http_x_bor_demo_invitation:$uri" $private_realm {\n'
                       '    default $private_browser_realm;\n'
                       '    "~^https://localhost:' + token + ':/api/" off;\n'
                       '  }')
        if config.count(browser_gate) != 1 or config.count(native_gate) != 1:
            raise ValueError('private_browser_and_native_gates_required')
        for variable in ['private_browser_realm', 'private_realm']:
            if len(re.findall(r'map\s+[^{]+\s+\$' + variable + r'\s*\{', config)) != 1:
                raise ValueError('ambiguous_private_gate')
        if re.findall(r'proxy_set_header\s+X-Bor-Demo-Invitation\s+([^;]+);',
                      config, re.IGNORECASE) != ['""']:
            raise ValueError('native_invitation_must_not_reach_api')
        if ('map $http_origin $cors_origin { default ""; "https://localhost" "https://localhost"; }' not in config
                or re.search(r'add_header\s+Access-Control-Allow-Credentials\b', config, re.IGNORECASE)
                or any(value != '$cors_origin always' for value in re.findall(
                    r'add_header\s+Access-Control-Allow-Origin\s+([^;]+);', config, re.IGNORECASE))):
            raise ValueError('native_origin_must_remain_exact')
        headers = re.findall(r'add_header\s+Set-Cookie\s+([^;]+);', config)
        includes = re.findall(r'include\s+[^;]*build/security-headers\.conf;', config)
        if not headers or any(value != '$private_cookie always' for value in headers) or len(headers) != len(includes):
            raise ValueError('cookie_security_header_inheritance')
except Exception:
    raise SystemExit('Proxy privacy audit failed. Inspect effective configuration locally.') from None
