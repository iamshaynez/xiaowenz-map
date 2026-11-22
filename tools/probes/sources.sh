#!/bin/zsh
# Reachability and speed of every data source, measured from this machine with curl.
# Usage: tools/probes/sources.sh > out/probes/sources.txt
# Only small requests or byte ranges are fetched here; the real downloads happen in the pipeline.
UA='xiaowenz-map-hangzhou/0.1 (local evaluation; open data for a pixel-art map)'
mkdir -p out/probes

head_one() {  # name url
  local out
  out=$(curl -s -I -L --max-time 25 -A "$UA" "$2" 2>/dev/null | awk 'BEGIN{s=""} /^HTTP/{s=$2} tolower($0) ~ /^content-length/{l=$2} tolower($0) ~ /^content-type/{t=$2} END{gsub("\r","",l); gsub("\r","",t); printf "http=%s size_MB=%.1f type=%s", s, l/1048576, t}')
  printf "%-22s %-110s %s\n" "$1" "${2:0:110}" "${out:-no response}"
}

range_one() {  # name url bytes
  local r
  r=$(curl -s -L --max-time 120 -A "$UA" -r "0-$(($3-1))" -o /dev/null -w "http=%{http_code} got_MB=%{size_download} speed_MBps=%{speed_download} t=%{time_total}" "$2" 2>/dev/null)
  printf "%-22s range %8d B: %s   (got and speed are raw bytes and bytes/s from curl)\n" "$1" "$3" "${r:-no response}"
}

echo "== HEAD requests"
head_one geofabrik-zj-pbf   https://download.geofabrik.de/asia/china/zhejiang/zhejiang-latest.osm.pbf
head_one copernicus-N30E120 https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_E120_00_DEM/Copernicus_DSM_COG_10_N30_00_E120_00_DEM.tif
head_one terrarium-z12      https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/3415/1686.png
head_one worldcover-N30E120 https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E120_Map.tif
head_one zenodo-asia-record https://zenodo.org/api/records/11397014
head_one osm-api            https://api.openstreetmap.org/api/0.6/capabilities
head_one overpass           https://overpass-api.de/api/status
head_one pypi-shapely       https://pypi.org/simple/shapely/
head_one pypi-tuna-shapely  https://pypi.tuna.tsinghua.edu.cn/simple/shapely/
head_one npm-osm-pbf        https://registry.npmjs.org/osm-pbf

echo
echo "== timed byte ranges (download speed from this machine)"
range_one geofabrik-zj-pbf   https://download.geofabrik.de/asia/china/zhejiang/zhejiang-latest.osm.pbf 8000000
range_one copernicus-N30E120 https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_E120_00_DEM/Copernicus_DSM_COG_10_N30_00_E120_00_DEM.tif 4000000
range_one terrarium-z12     https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/3415/1686.png 40000
range_one worldcover        https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E120_Map.tif 4000000
