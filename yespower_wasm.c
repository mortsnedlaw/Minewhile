#include <stdint.h>
#include <stddef.h>
#include "../vendor/yespower/yespower.h"

static yespower_local_t g_local;
static int g_ready = 0;

int yp_init(void) {
    if (g_ready) return 0;
    if (yespower_init_local(&g_local) != 0) return -1;
    g_ready = 1;
    return 0;
}

int yp_hash(const uint8_t *input, size_t input_len, uint8_t *output32) {
    if (!g_ready && yp_init() != 0) return -1;

    static const yespower_params_t params = {
        .version = YESPOWER_1_0,
        .N = 2048,
        .r = 32,
        .pers = NULL,
        .perslen = 0
    };

    yespower_binary_t out;
    if (yespower(&g_local, input, input_len, &params, &out) != 0)
        return -1;

    for (int i = 0; i < 32; i++)
        output32[i] = out.uc[i];

    return 0;
}

void yp_free(void) {
    if (g_ready) {
        yespower_free_local(&g_local);
        g_ready = 0;
    }
}
