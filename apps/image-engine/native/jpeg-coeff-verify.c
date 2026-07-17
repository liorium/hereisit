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

static void fail_jpeg(j_common_ptr common) {
  hereisit_error_manager *error = (hereisit_error_manager *)common->err;
  longjmp(error->jump, 1);
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
  if (jpeg_read_header(&value->decoder, TRUE) != JPEG_HEADER_OK) {
    jpeg_destroy_decompress(&value->decoder);
    fclose(value->file);
    value->file = NULL;
    return 0;
  }
  value->coefficients = jpeg_read_coefficients(&value->decoder);
  return value->coefficients != NULL;
}

static void close_coefficients(jpeg_coefficients *value) {
  if (value->file == NULL) return;
  jpeg_destroy_decompress(&value->decoder);
  fclose(value->file);
  value->file = NULL;
}

static int same_component(jpeg_coefficients *left, jpeg_coefficients *right, int component) {
  jpeg_component_info *left_info = &left->decoder.comp_info[component];
  jpeg_component_info *right_info = &right->decoder.comp_info[component];
  if (left_info->width_in_blocks != right_info->width_in_blocks ||
      left_info->height_in_blocks != right_info->height_in_blocks ||
      left_info->h_samp_factor != right_info->h_samp_factor ||
      left_info->v_samp_factor != right_info->v_samp_factor ||
      left_info->quant_tbl_no != right_info->quant_tbl_no) {
    return 0;
  }
  for (JDIMENSION row = 0; row < left_info->height_in_blocks; row++) {
    JBLOCKARRAY left_row = (*left->decoder.mem->access_virt_barray)(
        (j_common_ptr)&left->decoder, left->coefficients[component], row, 1, FALSE);
    JBLOCKARRAY right_row = (*right->decoder.mem->access_virt_barray)(
        (j_common_ptr)&right->decoder, right->coefficients[component], row, 1, FALSE);
    size_t bytes = (size_t)left_info->width_in_blocks * sizeof(JBLOCK);
    if (memcmp(left_row[0], right_row[0], bytes) != 0) return 0;
  }
  return 1;
}

static int same_coefficients(jpeg_coefficients *left, jpeg_coefficients *right) {
  if (setjmp(left->error.jump) != 0 || setjmp(right->error.jump) != 0) return 0;
  if (left->decoder.image_width != right->decoder.image_width ||
      left->decoder.image_height != right->decoder.image_height ||
      left->decoder.num_components != right->decoder.num_components ||
      left->decoder.jpeg_color_space != right->decoder.jpeg_color_space) {
    return 0;
  }
  for (int component = 0; component < left->decoder.num_components; component++) {
    if (!same_component(left, right, component)) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: jpeg-coeff-verify LEFT.jpg RIGHT.jpg\n", stderr);
    return 2;
  }
  jpeg_coefficients left;
  jpeg_coefficients right;
  if (!open_coefficients(argv[1], &left)) {
    fputs("left JPEG is invalid\n", stderr);
    return 2;
  }
  if (!open_coefficients(argv[2], &right)) {
    close_coefficients(&left);
    fputs("right JPEG is invalid\n", stderr);
    return 2;
  }
  int identical = same_coefficients(&left, &right);
  close_coefficients(&right);
  close_coefficients(&left);
  return identical ? 0 : 1;
}
