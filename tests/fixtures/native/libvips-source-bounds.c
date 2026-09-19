/* Diagnostic for CVE-2026-2913 on the exact runtime library, not a waiver.
 * Build: cc -std=c11 -Wall -Wextra -Werror -O2 this-file.c -ldl -o probe
 * Run inside the pinned engine with /usr/local/lib on LD_LIBRARY_PATH.
 * No libvips development package needed; signatures match connection.h.
 * The synthetic read never writes beyond the requested size, even on an
 * unpatched runtime. A small source is the positive functionality control.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct source_state { int64_t position, length; unsigned reads; };

static int64_t seek_source(void *source, int64_t offset, int whence, void *data) {
    (void) source;
    struct source_state *state = data;
    if (whence == SEEK_SET) state->position = offset;
    else if (whence == SEEK_CUR) state->position += offset;
    else if (whence == SEEK_END) state->position = state->length + offset;
    else return -1;
    return state->position < 0 ? -1 : state->position;
}

static int64_t read_source(void *source, void *buffer, int64_t size, void *data) {
    (void) source;
    struct source_state *state = data;
    state->reads++;
    if (state->position >= 4 || size <= 0) return 0;
    int64_t count = 4 - state->position;
    if (count > size) count = size;
    memcpy(buffer, "test" + state->position, (size_t) count);
    state->position += count;
    return count;
}

static void *symbol(void *library, const char *name) {
    void *value = dlsym(library, name);
    if (!value) { fputs("required runtime symbol missing\n", stderr); exit(1); }
    return value;
}

int main(void) {
    void *library = dlopen("/usr/local/lib/libvips.so.42", RTLD_NOW);
    if (!library) { fputs("runtime library unavailable\n", stderr); return 1; }
    int (*init)(const char *) = symbol(library, "vips_init");
    void *(*new_source)(void) = symbol(library, "vips_source_custom_new");
    const void *(*map)(void *, size_t *) = symbol(library, "vips_source_map");
    unsigned long (*connect)(void *, const char *, void (*)(void), void *, void *, int) =
        symbol(library, "g_signal_connect_data");
    const char *(*error)(void) = symbol(library, "vips_error_buffer");
    void (*clear_error)(void) = symbol(library, "vips_error_clear");
    void (*unref)(void *) = symbol(library, "g_object_unref");
    void (*shutdown)(void) = symbol(library, "vips_shutdown");
    if (init("source-bounds-probe") != 0) return 1;
    for (int oversized = 0; oversized < 2; oversized++) {
        struct source_state state = {0, oversized ? INT64_C(4294968320) : 4, 0};
        void *source = new_source();
        if (!source) return 1;
        connect(source, "seek", (void (*)(void)) seek_source, &state, NULL, 0);
        connect(source, "read", (void (*)(void)) read_source, &state, NULL, 0);
        size_t length = 0;
        const void *bytes = map(source, &length);
        int passed = oversized
            ? bytes == NULL && strstr(error(), "length overflow") != NULL && state.reads == 0
            : bytes != NULL && length == 4 && memcmp(bytes, "test", 4) == 0;
        unref(source);
        clear_error();
        if (!passed) { fputs("source boundary regression\n", stderr); return 1; }
    }
    shutdown();
    dlclose(library);
    puts("{\"smallSourceMapped\":true,\"oversizedSourceRejectedBeforeRead\":true}");
    return 0;
}
