#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "../vendor/yespower/yespower.h"

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *hex, uint8_t *out, size_t bytes) {
    if (strlen(hex) != bytes * 2) return -1;
    for (size_t i = 0; i < bytes; i++) {
        int hi = hex_nibble(hex[i * 2]);
        int lo = hex_nibble(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

static int le256_lte(const uint8_t *a, const uint8_t *b) {
    for (int i = 31; i >= 0; i--) {
        if (a[i] < b[i]) return 1;
        if (a[i] > b[i]) return 0;
    }
    return 1;
}

static int params_for(const char *id, yespower_params_t *params) {
    memset(params, 0, sizeof(*params));
    params->version = YESPOWER_1_0;

    if (strcmp(id, "yespower") == 0) {
        params->N = 2048; params->r = 32;
    } else if (strcmp(id, "yespowertide") == 0) {
        params->N = 2048; params->r = 8;
    } else if (strcmp(id, "yespowerr16") == 0) {
        params->N = 4096; params->r = 16;
    } else if (strcmp(id, "yespowerurx") == 0) {
        static const char p[] = "UraniumX";
        params->N = 2048; params->r = 32; params->pers = (const uint8_t *)p; params->perslen = sizeof(p) - 1;
    } else if (strcmp(id, "yespoweradvc") == 0) {
        static const char p[] = "Let the quest begin";
        params->N = 2048; params->r = 32; params->pers = (const uint8_t *)p; params->perslen = sizeof(p) - 1;
    } else if (strcmp(id, "yespowerltncg") == 0) {
        static const char p[] = "LTNCGYES";
        params->N = 2048; params->r = 32; params->pers = (const uint8_t *)p; params->perslen = sizeof(p) - 1;
    } else if (strcmp(id, "yespowersugar") == 0) {
        static const char p[] = "Satoshi Nakamoto 31/Oct/2008 Proof-of-work is essentially one-CPU-one-vote";
        params->N = 2048; params->r = 32; params->pers = (const uint8_t *)p; params->perslen = sizeof(p) - 1;
    } else {
        return -1;
    }
    return 0;
}

int main(void) {
    yespower_local_t local;
    if (yespower_init_local(&local) != 0) {
        fprintf(stderr, "yespower_init_local failed\n");
        return 1;
    }

    char line[768];
    while (fgets(line, sizeof(line), stdin)) {
        unsigned long long id = 0;
        char algorithm[32] = {0};
        char header_hex[153] = {0};
        char target_hex[65] = {0};
        char nonce_hex[9] = {0};

        if (sscanf(line, "%llu %31s %152s %64s %8s", &id, algorithm, header_hex, target_hex, nonce_hex) != 5) {
            printf("%llu -1\n", id);
            fflush(stdout);
            continue;
        }

        yespower_params_t params;
        if (params_for(algorithm, &params) != 0) {
            printf("%llu -1\n", id);
            fflush(stdout);
            continue;
        }

        uint8_t header[80] = {0};
        uint8_t target[32] = {0};
        if (parse_hex(header_hex, header, 76) != 0 || parse_hex(target_hex, target, 32) != 0 || strlen(nonce_hex) != 8) {
            printf("%llu -1\n", id);
            fflush(stdout);
            continue;
        }

        char *end = NULL;
        unsigned long nonce_ul = strtoul(nonce_hex, &end, 16);
        if (!end || *end != '\0' || nonce_ul > 0xffffffffUL) {
            printf("%llu -1\n", id);
            fflush(stdout);
            continue;
        }

        uint32_t nonce = (uint32_t)nonce_ul;
        header[76] = (uint8_t)(nonce & 0xff);
        header[77] = (uint8_t)((nonce >> 8) & 0xff);
        header[78] = (uint8_t)((nonce >> 16) & 0xff);
        header[79] = (uint8_t)((nonce >> 24) & 0xff);

        yespower_binary_t hash;
        if (yespower(&local, header, sizeof(header), &params, &hash) != 0) {
            printf("%llu -1\n", id);
            fflush(stdout);
            continue;
        }

        printf("%llu %d\n", id, le256_lte(hash.uc, target));
        fflush(stdout);
    }

    yespower_free_local(&local);
    return 0;
}
