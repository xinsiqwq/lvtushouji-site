import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

function createGraticuleFeatures(): FeatureCollection<Geometry, GeoJsonProperties>['features'] {
  const features: FeatureCollection<Geometry, GeoJsonProperties>['features'] = [];
  for (let lat = -60; lat <= 75; lat += 15) {
    const coords: number[][] = [];
    for (let lng = -180; lng <= 180; lng += 10) {
      coords.push([lng, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'graticule' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  for (let lng = -150; lng <= 180; lng += 30) {
    const coords: number[][] = [];
    for (let lat = -75; lat <= 80; lat += 10) {
      coords.push([lng, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'graticule' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  return features;
}

/** Simplified offline landmass + China coastal/border contours + graticules for MapLibre fallback. */
export const OFFLINE_WORLD_GEOJSON: FeatureCollection<Geometry, GeoJsonProperties> = {
  type: 'FeatureCollection',
  features: [
    ...createGraticuleFeatures(),
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Eurasia' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-9.5, 36.5],
            [-9.2, 43.0],
            [-2.0, 43.5],
            [-4.5, 48.5],
            [2.0, 51.0],
            [8.5, 54.0],
            [10.0, 57.5],
            [5.0, 60.5],
            [15.0, 69.0],
            [28.0, 71.0],
            [42.0, 68.0],
            [60.0, 70.0],
            [85.0, 73.5],
            [105.0, 77.0],
            [140.0, 73.0],
            [175.0, 67.0],
            [168.0, 60.0],
            [161.0, 55.0],
            [156.0, 51.0],
            [142.0, 53.0],
            [140.5, 46.0],
            [135.0, 43.5],
            [129.0, 41.0],
            [129.5, 35.0],
            [126.5, 37.5],
            [124.2, 39.8],
            [121.5, 38.9],
            [118.0, 39.0],
            [122.0, 37.4],
            [120.5, 35.8],
            [121.9, 31.2],
            [121.5, 29.8],
            [119.5, 25.8],
            [116.8, 23.3],
            [114.2, 22.3],
            [110.2, 20.1],
            [108.5, 21.5],
            [109.2, 16.0],
            [109.0, 11.5],
            [104.5, 8.6],
            [100.5, 13.5],
            [103.8, 1.3],
            [98.5, 5.5],
            [96.5, 16.5],
            [91.5, 22.0],
            [86.5, 20.0],
            [80.2, 13.0],
            [77.5, 8.1],
            [72.8, 19.0],
            [68.5, 23.5],
            [62.0, 25.0],
            [56.5, 26.5],
            [59.8, 22.5],
            [52.0, 15.5],
            [43.5, 12.6],
            [39.0, 21.5],
            [34.5, 28.0],
            [32.5, 31.2],
            [35.8, 36.2],
            [27.0, 38.5],
            [26.0, 40.5],
            [23.5, 38.0],
            [19.5, 40.5],
            [15.5, 38.0],
            [12.5, 42.0],
            [9.0, 44.5],
            [3.0, 42.5],
            [-5.5, 36.0],
            [-9.5, 36.5],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'china-outline', name: 'China' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [73.6, 39.5],
          [75.5, 37.0],
          [79.0, 34.5],
          [81.5, 30.2],
          [88.0, 27.9],
          [92.0, 27.7],
          [97.4, 28.2],
          [97.8, 24.5],
          [100.0, 21.5],
          [102.5, 22.5],
          [106.5, 22.8],
          [108.5, 21.5],
          [110.2, 20.1],
          [114.2, 22.3],
          [117.5, 23.8],
          [120.5, 27.5],
          [121.9, 31.2],
          [120.2, 34.5],
          [122.4, 37.4],
          [119.5, 39.8],
          [124.2, 39.9],
          [128.0, 41.5],
          [130.6, 42.6],
          [134.8, 48.2],
          [127.5, 49.8],
          [121.2, 53.3],
          [117.6, 49.5],
          [111.5, 45.0],
          [104.0, 41.8],
          [96.5, 42.8],
          [90.5, 45.2],
          [87.2, 49.1],
          [83.0, 47.0],
          [80.2, 44.5],
          [75.2, 40.5],
          [73.6, 39.5],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Japan' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [130.5, 31.5],
            [131.0, 34.0],
            [136.5, 35.0],
            [140.8, 36.0],
            [141.5, 41.2],
            [145.0, 43.8],
            [141.8, 45.4],
            [139.8, 41.0],
            [136.8, 37.2],
            [132.5, 35.0],
            [130.5, 31.5],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Taiwan & Hainan' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[120.1, 22.0], [120.9, 22.8], [121.9, 25.1], [121.0, 25.0], [120.2, 23.6], [120.1, 22.0]]],
          [[[108.7, 18.4], [110.2, 18.3], [111.0, 19.8], [109.8, 20.0], [108.7, 19.3], [108.7, 18.4]]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Africa' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-17.2, 14.7],
            [-6.0, 35.8],
            [10.5, 37.1],
            [32.4, 31.2],
            [43.4, 12.6],
            [51.3, 11.9],
            [40.5, -10.5],
            [32.9, -26.0],
            [20.0, -34.8],
            [14.5, -22.5],
            [9.5, 4.0],
            [-7.5, 4.5],
            [-17.2, 14.7],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Americas' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-168.0, 65.5],
              [-140.0, 70.0],
              [-95.0, 70.0],
              [-55.0, 52.0],
              [-66.0, 44.0],
              [-81.0, 25.0],
              [-97.0, 26.0],
              [-88.0, 21.0],
              [-79.5, 9.0],
              [-105.0, 20.0],
              [-124.0, 40.0],
              [-135.0, 58.0],
              [-165.0, 55.0],
              [-168.0, 65.5],
            ],
          ],
          [
            [
              [-79.5, 9.0],
              [-62.0, 10.5],
              [-35.0, -6.0],
              [-48.0, -26.0],
              [-68.0, -54.0],
              [-74.5, -52.0],
              [-71.5, -33.0],
              [-77.0, -12.0],
              [-81.0, -4.5],
              [-79.5, 9.0],
            ],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'land', name: 'Australia' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [113.5, -22.0],
            [129.0, -14.0],
            [142.5, -10.8],
            [153.5, -28.0],
            [149.8, -37.5],
            [138.0, -35.5],
            [115.2, -34.0],
            [113.5, -22.0],
          ],
        ],
      },
    },
  ],
};
