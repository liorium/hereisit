#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <jpeglib.h>

typedef struct {
  struct jpeg_error_mgr base;
  jmp_buf jump;
} hereisit_error_manager;

typedef struct {
  FILE *file;
  struct jpeg_decompress_struct decoder;
  hereisit_error_manager error;
  jvirt_barray_ptr *coefficients;
} jpeg_coefficients;

typedef enum {
  TRANSFORM_IDENTITY,
  TRANSFORM_FLIP_H,
  TRANSFORM_ROTATE_180,
  TRANSFORM_FLIP_V,
  TRANSFORM_TRANSPOSE,
  TRANSFORM_ROTATE_90,
  TRANSFORM_TRANSVERSE,
  TRANSFORM_ROTATE_270
} transform_kind;

static void fail_jpeg(j_common_ptr common) {
  hereisit_error_manager *error = (hereisit_error_manager *)common->err;
  longjmp(error->jump, 1);
}

static int parse_transform(const char *value, transform_kind *transform) {
  static const char *names[] = {"identity",  "flip-h",    "rotate-180", "flip-v",
                                "transpose", "rotate-90", "transverse", "rotate-270"};
  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    if (strcmp(value, names[index]) == 0) {
      *transform = (transform_kind)index;
      return 1;
    }
  }
  return 0;
}

static int swaps_axes(transform_kind transform) {
  return transform == TRANSFORM_TRANSPOSE || transform == TRANSFORM_ROTATE_90 ||
         transform == TRANSFORM_TRANSVERSE || transform == TRANSFORM_ROTATE_270;
}

static int open_coefficients(const char *path, jpeg_coefficients *value) {
  memset(value, 0, sizeof(*value));
  value->file = fopen(path, "rb");
  if (value->file == NULL) return 0;
  value->decoder.err = jpeg_std_error(&value->error.base);
  value->error.base.error_exit = fail_jpeg;
  if (setjmp(value->error.jump) != 0) {
    jpeg_destroy_decompress(&value->decoder);
    fclose(value->file);
    value->file = NULL;
    return 0;
  }
  jpeg_create_decompress(&value->decoder);
  jpeg_stdio_src(&value->decoder, value->file);
  if (jpeg_read_header(&value->decoder, TRUE) != JPEG_HEADER_OK) return 0;
  value->coefficients = jpeg_read_coefficients(&value->decoder);
  return value->coefficients != NULL;
}

static void close_coefficients(jpeg_coefficients *value) {
  if (value->file == NULL) return;
  jpeg_destroy_decompress(&value->decoder);
  fclose(value->file);
  value->file = NULL;
}

static int same_quantization(jpeg_coefficients *source, jpeg_coefficients *candidate,
                             transform_kind transform) {
  for (int index = 0; index < NUM_QUANT_TBLS; index++) {
    JQUANT_TBL *left = source->decoder.quant_tbl_ptrs[index];
    JQUANT_TBL *right = candidate->decoder.quant_tbl_ptrs[index];
    if ((left == NULL) != (right == NULL)) return 0;
    if (left == NULL) continue;
    for (int row = 0; row < DCTSIZE; row++) {
      for (int column = 0; column < DCTSIZE; column++) {
        int source_index = swaps_axes(transform) ? column * DCTSIZE + row : row * DCTSIZE + column;
        int candidate_index = row * DCTSIZE + column;
        if (left->quantval[source_index] != right->quantval[candidate_index]) return 0;
      }
    }
  }
  return 1;
}

static int same_header(jpeg_coefficients *source, jpeg_coefficients *candidate,
                       transform_kind transform) {
  int swap = swaps_axes(transform);
  JDIMENSION expected_width = swap ? source->decoder.image_height : source->decoder.image_width;
  JDIMENSION expected_height = swap ? source->decoder.image_width : source->decoder.image_height;
  if (candidate->decoder.image_width != expected_width ||
      candidate->decoder.image_height != expected_height) {
    fputs("dimension-mismatch\n", stderr);
    return 0;
  }
  if (
      source->decoder.num_components != candidate->decoder.num_components ||
      source->decoder.jpeg_color_space != candidate->decoder.jpeg_color_space ||
      source->decoder.data_precision != candidate->decoder.data_precision ||
      source->decoder.restart_interval != candidate->decoder.restart_interval) {
    fputs("header-mismatch\n", stderr);
    return 0;
  }
  if (!same_quantization(source, candidate, transform)) {
    fputs("quantization-mismatch\n", stderr);
    return 0;
  }
  for (int component = 0; component < source->decoder.num_components; component++) {
    jpeg_component_info *left = &source->decoder.comp_info[component];
    jpeg_component_info *right = &candidate->decoder.comp_info[component];
    int expected_h = swap ? left->v_samp_factor : left->h_samp_factor;
    int expected_v = swap ? left->h_samp_factor : left->v_samp_factor;
    JDIMENSION expected_blocks_w = swap ? left->height_in_blocks : left->width_in_blocks;
    JDIMENSION expected_blocks_h = swap ? left->width_in_blocks : left->height_in_blocks;
    if (left->component_id != right->component_id || left->quant_tbl_no != right->quant_tbl_no ||
        right->h_samp_factor != expected_h || right->v_samp_factor != expected_v ||
        right->width_in_blocks != expected_blocks_w || right->height_in_blocks != expected_blocks_h) {
      fputs("component-layout-mismatch\n", stderr);
      return 0;
    }
  }
  return 1;
}

static void destination_position(transform_kind transform, JDIMENSION source_x,
                                 JDIMENSION source_y, JDIMENSION source_width,
                                 JDIMENSION source_height, JDIMENSION *destination_x,
                                 JDIMENSION *destination_y) {
  switch (transform) {
    case TRANSFORM_IDENTITY:
      *destination_x = source_x;
      *destination_y = source_y;
      break;
    case TRANSFORM_FLIP_H:
      *destination_x = source_width - 1 - source_x;
      *destination_y = source_y;
      break;
    case TRANSFORM_ROTATE_180:
      *destination_x = source_width - 1 - source_x;
      *destination_y = source_height - 1 - source_y;
      break;
    case TRANSFORM_FLIP_V:
      *destination_x = source_x;
      *destination_y = source_height - 1 - source_y;
      break;
    case TRANSFORM_TRANSPOSE:
      *destination_x = source_y;
      *destination_y = source_x;
      break;
    case TRANSFORM_ROTATE_90:
      *destination_x = source_height - 1 - source_y;
      *destination_y = source_x;
      break;
    case TRANSFORM_TRANSVERSE:
      *destination_x = source_height - 1 - source_y;
      *destination_y = source_width - 1 - source_x;
      break;
    case TRANSFORM_ROTATE_270:
      *destination_x = source_y;
      *destination_y = source_width - 1 - source_x;
      break;
  }
}

static JCOEF expected_coefficient(const JBLOCK source, int destination_u, int destination_v,
                                  transform_kind transform) {
  int source_u = swaps_axes(transform) ? destination_v : destination_u;
  int source_v = swaps_axes(transform) ? destination_u : destination_v;
  int sign = 1;
  if ((transform == TRANSFORM_FLIP_H || transform == TRANSFORM_ROTATE_180 ||
       transform == TRANSFORM_ROTATE_90 || transform == TRANSFORM_TRANSVERSE) &&
      (destination_u & 1)) {
    sign = -sign;
  }
  if ((transform == TRANSFORM_FLIP_V || transform == TRANSFORM_ROTATE_180 ||
       transform == TRANSFORM_TRANSVERSE || transform == TRANSFORM_ROTATE_270) &&
      (destination_v & 1)) {
    sign = -sign;
  }
  return (JCOEF)(sign * source[source_v * DCTSIZE + source_u]);
}

static int same_component(jpeg_coefficients *source, jpeg_coefficients *candidate, int component,
                          transform_kind transform) {
  jpeg_component_info *source_info = &source->decoder.comp_info[component];
  for (JDIMENSION source_y = 0; source_y < source_info->height_in_blocks; source_y++) {
    JBLOCKARRAY source_row = (*source->decoder.mem->access_virt_barray)(
        (j_common_ptr)&source->decoder, source->coefficients[component], source_y, 1, FALSE);
    for (JDIMENSION source_x = 0; source_x < source_info->width_in_blocks; source_x++) {
      JDIMENSION destination_x;
      JDIMENSION destination_y;
      destination_position(transform, source_x, source_y, source_info->width_in_blocks,
                           source_info->height_in_blocks, &destination_x, &destination_y);
      JBLOCKARRAY candidate_row = (*candidate->decoder.mem->access_virt_barray)(
          (j_common_ptr)&candidate->decoder, candidate->coefficients[component], destination_y, 1,
          FALSE);
      for (int destination_v = 0; destination_v < DCTSIZE; destination_v++) {
        for (int destination_u = 0; destination_u < DCTSIZE; destination_u++) {
          int index = destination_v * DCTSIZE + destination_u;
          if (candidate_row[0][destination_x][index] !=
              expected_coefficient(source_row[0][source_x], destination_u, destination_v,
                                   transform)) {
            fputs("coefficient-mismatch\n", stderr);
            return 0;
          }
        }
      }
    }
  }
  return 1;
}

static int same_coefficients(jpeg_coefficients *source, jpeg_coefficients *candidate,
                             transform_kind transform) {
  if (!same_header(source, candidate, transform)) return 0;
  for (int component = 0; component < source->decoder.num_components; component++) {
    if (!same_component(source, candidate, component, transform)) return 0;
  }
  return 1;
}

static size_t block_count(jpeg_coefficients *value) {
  size_t total = 0;
  for (int component = 0; component < value->decoder.num_components; component++) {
    jpeg_component_info *info = &value->decoder.comp_info[component];
    total += (size_t)info->width_in_blocks * (size_t)info->height_in_blocks;
  }
  return total;
}

static int sampling_string(jpeg_coefficients *value, char *output, size_t capacity) {
  size_t used = 0;
  for (int component = 0; component < value->decoder.num_components; component++) {
    jpeg_component_info *info = &value->decoder.comp_info[component];
    int written = snprintf(output + used, capacity - used, "%s%dx%d", component == 0 ? "" : ",",
                           info->h_samp_factor, info->v_samp_factor);
    if (written < 0 || (size_t)written >= capacity - used) return 0;
    used += (size_t)written;
  }
  return 1;
}

int main(int argc, char **argv) {
  transform_kind transform;
  if (argc != 4 || !parse_transform(argv[1], &transform)) {
    fputs("invalid-arguments\n", stderr);
    return 2;
  }
  jpeg_coefficients source;
  jpeg_coefficients candidate;
  if (!open_coefficients(argv[2], &source)) {
    fputs("invalid-input\n", stderr);
    return 2;
  }
  if (!open_coefficients(argv[3], &candidate)) {
    close_coefficients(&source);
    fputs("invalid-candidate\n", stderr);
    return 2;
  }
  if (setjmp(source.error.jump) != 0 || setjmp(candidate.error.jump) != 0) {
    close_coefficients(&candidate);
    close_coefficients(&source);
    fputs("coefficient-read-failed\n", stderr);
    return 2;
  }
  int exact = same_coefficients(&source, &candidate, transform);
  char source_sampling[64];
  char candidate_sampling[64];
  if (!sampling_string(&source, source_sampling, sizeof(source_sampling)) ||
      !sampling_string(&candidate, candidate_sampling, sizeof(candidate_sampling))) {
    close_coefficients(&candidate);
    close_coefficients(&source);
    fputs("sampling-invalid\n", stderr);
    return 2;
  }
  size_t source_blocks = block_count(&source);
  size_t candidate_blocks = block_count(&candidate);
  printf("{\"exact\":%s,\"sourceSampling\":\"%s\",\"candidateSampling\":\"%s\","
         "\"sourceBlocks\":%zu,\"candidateBlocks\":%zu}\n",
         exact ? "true" : "false", source_sampling, candidate_sampling, source_blocks,
         candidate_blocks);
  close_coefficients(&candidate);
  close_coefficients(&source);
  return 0;
}
